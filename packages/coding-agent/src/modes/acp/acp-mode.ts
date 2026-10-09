/**
 * ACP mode: serve the Agent Client Protocol (v2 draft) over stdio.
 *
 * Speaks newline-delimited JSON-RPC on stdin/stdout via the pinned SDK, so an
 * ACP client (e.g. an editor) can drive pi sessions. main.ts already ran
 * `takeOverStdout()`, so protocol frames go through `writeRawStdout()` while
 * everything else (console.log, tool chatter) lands on stderr.
 *
 * Protocol surface (PR1 baseline):
 * - `initialize` advertises `capabilities.session`; no other capabilities yet.
 * - `session/new`, `session/list`, `session/resume`, `session/close`,
 *   `session/prompt`, `session/cancel`. `session/resume` with
 *   `replayFrom: {type: "start"}` replays the active-branch history first.
 * - One ACP prompt turn is one `session.prompt()`: `state_update` running at
 *   start, idle with a stop reason at `agent_settled`. Never end a turn on
 *   `agent_end`/`turn_end`: those fire per inner loop, `agent_settled` once.
 * - Text and thinking stream as `agent_message_chunk`/`agent_thought_chunk`
 *   keyed by a stable message id per assistant message; tool calls become
 *   `tool_call_update`s with text output.
 */

import { Readable } from "node:stream";
import type {
	AgentApp,
	AgentContext,
	ContentBlock,
	SessionUpdate,
	StopReason,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
	agent,
	ContentBlock as ContentBlockGuard,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent as PiImageContent } from "@earendil-works/pi-ai/compat";
import { APP_NAME, VERSION } from "../../config.ts";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { formatNoModelsAvailableMessage } from "../../core/auth-guidance.ts";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { resolvePath } from "../../utils/paths.ts";

export interface AcpModeOptions {
	sessionDir?: string;
}

/** Per-session live state. ACP session id === pi session id. */
interface AcpSession {
	runtime: AgentSessionRuntime;
	/** Sends one `session/update` for this session. */
	emit: (update: SessionUpdate) => void;
	unsubscribe: () => void;
	/** True from `session/prompt` until `agent_settled` resolves the turn. */
	turnActive: boolean;
	/** True once `session/cancel` lands, until the turn settles. */
	cancelling: boolean;
	/** Skip pi's own user `message_start` for the prompt the client already has. */
	skipNextUserMessage: boolean;
	assistantMessageId: string | undefined;
	thoughtMessageId: string | undefined;
}

/**
 * Build the ACP agent app over pi sessions. Split from `runAcpMode` so tests
 * can drive the app in-process; stdio wiring stays in `runAcpMode`.
 */
export function createAcpApp(
	initialRuntime: AgentSessionRuntime,
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: AcpModeOptions,
): { app: AgentApp; disposeAll: () => Promise<void> } {
	const sessions = new Map<string, AcpSession>();
	let initial: AgentSessionRuntime | undefined = initialRuntime;
	const app = agent({ name: `${APP_NAME}-acp` });

	/** PR3 seam: bind the tool_call gate and UI context here, before first use. */
	const setupSession = async (session: AgentSession): Promise<void> => {
		await session.bindExtensions({ mode: "rpc" });
	};

	const openSession = async (runtime: AgentSessionRuntime, client: AgentContext): Promise<AcpSession> => {
		const sessionId = runtime.session.sessionId;
		const existing = sessions.get(sessionId);
		if (existing !== undefined) return existing;
		await setupSession(runtime.session);
		const state: AcpSession = {
			runtime,
			emit: (update) => {
				void client.notify(methods.client.session.update, { sessionId, update }).catch((error: unknown) => {
					console.error(
						`[acp] session/update notify failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			},
			unsubscribe: () => {},
			turnActive: false,
			cancelling: false,
			skipNextUserMessage: false,
			assistantMessageId: undefined,
			thoughtMessageId: undefined,
		};
		// PR5 seam: watch model/thinking changes here for config_option_update.
		state.unsubscribe = runtime.session.subscribe((event) => onSessionEvent(state, event));
		sessions.set(sessionId, state);
		return state;
	};

	/** Adopt the CLI runtime for the first matching `session/new`, else build one. */
	const createSession = async (cwd: string, client: AgentContext): Promise<AcpSession> => {
		const resolvedCwd = resolvePath(cwd);
		const pending = initial;
		initial = undefined;
		if (pending !== undefined) {
			if (resolvePath(pending.cwd) === resolvedCwd && pending.session.sessionManager.getEntryCount() === 0) {
				assertUsableModel(pending.session);
				return openSession(pending, client);
			}
			await pending.dispose();
		}
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: resolvedCwd,
			agentDir: initialRuntime.services.agentDir,
			sessionManager: SessionManager.create(resolvedCwd, options.sessionDir),
			sessionStartEvent: { type: "session_start", reason: "new" },
		});
		assertUsableModel(runtime.session);
		return openSession(runtime, client);
	};

	/** Reopen a persisted session, reusing the live runtime when present. */
	const resumeSession = async (sessionId: string, cwd: string, client: AgentContext): Promise<AcpSession> => {
		const live = sessions.get(sessionId);
		if (live !== undefined) {
			if (resolvePath(live.runtime.cwd) !== resolvePath(cwd)) {
				throw RequestError.invalidParams(`Session "${sessionId}" belongs to a different working directory`);
			}
			return live;
		}
		const path = SessionManager.findById(cwd, sessionId, options.sessionDir);
		if (path === undefined) throw RequestError.invalidParams(`Unknown session "${sessionId}"`);
		if (initial !== undefined) {
			await initial.dispose();
			initial = undefined;
		}
		const sessionManager = SessionManager.open(path, options.sessionDir);
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: initialRuntime.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume" },
		});
		if (runtime.session.sessionId !== sessionId) {
			await runtime.dispose();
			throw RequestError.invalidParams(`Session file mismatch for "${sessionId}"`);
		}
		assertUsableModel(runtime.session);
		return openSession(runtime, client);
	};

	const closeSession = async (sessionId: string): Promise<void> => {
		const state = sessions.get(sessionId);
		if (state === undefined) return;
		sessions.delete(sessionId);
		state.unsubscribe();
		await state.runtime.session.abort();
		await state.runtime.dispose();
	};

	const onSessionEvent = (state: AcpSession, event: AgentSessionEvent): void => {
		switch (event.type) {
			case "message_start": {
				if (event.message.role === "assistant") {
					state.assistantMessageId = crypto.randomUUID();
					state.thoughtMessageId = undefined;
				} else if (event.message.role === "user") {
					if (state.skipNextUserMessage) {
						state.skipNextUserMessage = false;
					} else {
						state.emit({
							sessionUpdate: "user_message",
							messageId: crypto.randomUUID(),
							content: [{ type: "text", text: userMessageText(event.message) }],
						});
					}
				}
				return;
			}
			case "message_update": {
				if (event.assistantMessageEvent.type === "text_delta") {
					state.assistantMessageId ??= crypto.randomUUID();
					state.emit({
						sessionUpdate: "agent_message_chunk",
						messageId: state.assistantMessageId,
						content: { type: "text", text: event.assistantMessageEvent.delta },
					});
				} else if (event.assistantMessageEvent.type === "thinking_delta") {
					state.thoughtMessageId ??= crypto.randomUUID();
					state.emit({
						sessionUpdate: "agent_thought_chunk",
						messageId: state.thoughtMessageId,
						content: { type: "text", text: event.assistantMessageEvent.delta },
					});
				}
				return;
			}
			case "tool_execution_start": {
				const { title, kind, locations } = describeToolCall(event.toolName, event.args, state.runtime.cwd);
				state.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					name: event.toolName,
					title,
					kind,
					status: "pending",
					rawInput: event.args,
					...(locations.length > 0 ? { locations } : {}),
				});
				state.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: "in_progress",
				});
				return;
			}
			case "tool_execution_end": {
				const status = !event.isError ? "completed" : state.cancelling ? "cancelled" : "failed";
				const text = toolResultText(event.result);
				// PR4 seam: append diff content for edit/write calls here.
				const content: ToolCallContent[] =
					text.length > 0 ? [{ type: "content", content: { type: "text", text } }] : [];
				state.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status,
					rawOutput: text,
					...(content.length > 0 ? { content } : {}),
				});
				return;
			}
			case "agent_settled": {
				const stopReason = stopReasonFor(state, event.aborted);
				if (stopReason === "error") {
					state.emit({
						sessionUpdate: "agent_message",
						messageId: crypto.randomUUID(),
						content: [
							{ type: "text", text: lastAssistantError(state.runtime.session) ?? "The agent run failed." },
						],
					});
				}
				const usage = state.runtime.session.getContextUsage();
				if (usage !== undefined) {
					const stats = state.runtime.session.getSessionStats();
					state.emit({
						sessionUpdate: "usage_update",
						used: usage.tokens ?? 0,
						size: usage.contextWindow,
						...(stats.cost > 0 ? { cost: { amount: stats.cost, currency: "USD" } } : {}),
					});
				}
				state.emit({ sessionUpdate: "state_update", state: "idle", stopReason });
				return;
			}
			case "session_info_changed": {
				state.emit({ sessionUpdate: "session_info_update", title: event.name ?? null });
				return;
			}
			default:
				return;
		}
	};

	/**
	 * Replay the active-branch history as the whole-message entities the live
	 * turns streamed. Message ids are deterministic per entry; tool calls reuse
	 * their live ids, so a resumed client sees the same entities.
	 */
	const replayHistory = (state: AcpSession): void => {
		const branch = state.runtime.session.sessionManager.getBranch();
		// Results carry no arguments; recover each call's input from the
		// assistant message that requested it, for titles and rawInput.
		const toolInputs = new Map<string, unknown>();
		for (const entry of branch) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") toolInputs.set(block.id, block.arguments);
			}
		}
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") {
				const content: ContentBlock[] =
					typeof message.content === "string"
						? [{ type: "text", text: message.content }]
						: message.content.map((block) =>
								block.type === "image"
									? { type: "image", data: block.data, mimeType: block.mimeType }
									: { type: "text", text: block.text },
							);
				state.emit({ sessionUpdate: "user_message", messageId: `replay-${entry.id}`, content });
			} else if (message.role === "assistant") {
				const text = message.content
					.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
					.map((block) => block.text)
					.join("");
				if (text.length > 0) {
					state.emit({
						sessionUpdate: "agent_message",
						messageId: `replay-${entry.id}`,
						content: [{ type: "text", text }],
					});
				}
				const thinking = message.content
					.filter((block): block is Extract<typeof block, { type: "thinking" }> => block.type === "thinking")
					.map((block) => block.thinking)
					.join("");
				if (thinking.length > 0) {
					state.emit({
						sessionUpdate: "agent_thought",
						messageId: `replay-${entry.id}-thought`,
						content: [{ type: "text", text: thinking }],
					});
				}
			} else if (message.role === "toolResult") {
				const input = toolInputs.get(message.toolCallId) ?? {};
				const { title, kind, locations } = describeToolCall(message.toolName, input, state.runtime.cwd);
				const output = message.content
					.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				const content: ToolCallContent[] =
					output.length > 0 ? [{ type: "content", content: { type: "text", text: output } }] : [];
				state.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: message.toolCallId,
					name: message.toolName,
					title,
					kind,
					status: message.isError ? "failed" : "completed",
					rawInput: input,
					rawOutput: output,
					...(content.length > 0 ? { content } : {}),
					...(locations.length > 0 ? { locations } : {}),
				});
			}
		}
	};

	const runTurn = async (state: AcpSession, text: string, images: PiImageContent[] | undefined): Promise<void> => {
		state.turnActive = true;
		state.skipNextUserMessage = true;
		try {
			await state.runtime.session.prompt(text, {
				images,
				source: "rpc",
				preflightResult: (disposition) => {
					if (disposition !== "started") return;
					state.cancelling = false;
					state.emit({ sessionUpdate: "state_update", state: "running" });
				},
			});
		} finally {
			state.turnActive = false;
		}
	};

	app.onRequest(methods.agent.initialize, () => ({
		protocolVersion: PROTOCOL_VERSION,
		info: { name: `${APP_NAME}-acp`, version: VERSION },
		capabilities: { session: { prompt: { image: {}, embeddedContext: {} } } },
	}));

	// PR5 seam: session/new returns configOptions and availableCommands here.
	app.onRequest(methods.agent.session.new, async ({ params, client }) => {
		try {
			const state = await createSession(params.cwd, client);
			return { sessionId: state.runtime.session.sessionId };
		} catch (error) {
			throw RequestError.invalidParams(error instanceof Error ? error.message : String(error));
		}
	});

	app.onRequest(methods.agent.session.list, async ({ params }) => {
		const infos =
			params.cwd === undefined || params.cwd === null
				? await SessionManager.listAll(options.sessionDir)
				: await SessionManager.list(params.cwd, options.sessionDir);
		const seen = new Set(infos.map((info) => info.id));
		const sessionsOut = infos.map((info) => ({
			sessionId: info.id,
			cwd: info.cwd,
			title: info.name ?? null,
			updatedAt: info.modified.toISOString(),
		}));
		// Live-but-unpersisted sessions (adopted initial runtime, or files the
		// session manager creates lazily on first conversation).
		for (const state of sessions.values()) {
			const id = state.runtime.session.sessionId;
			if (seen.has(id)) continue;
			if (
				params.cwd !== undefined &&
				params.cwd !== null &&
				resolvePath(state.runtime.cwd) !== resolvePath(params.cwd)
			) {
				continue;
			}
			seen.add(id);
			sessionsOut.push({
				sessionId: id,
				cwd: state.runtime.cwd,
				title: state.runtime.session.sessionName ?? null,
				updatedAt: new Date().toISOString(),
			});
		}
		return { sessions: sessionsOut };
	});

	// PR5 seam: config/commands land here.
	app.onRequest(methods.agent.session.resume, async ({ params, client }) => {
		if (params.replayFrom !== undefined && params.replayFrom !== null && params.replayFrom.type !== "start") {
			throw RequestError.invalidParams(`Unsupported replay cursor "${params.replayFrom.type}"`);
		}
		try {
			const state = await resumeSession(params.sessionId, params.cwd, client);
			if (params.replayFrom?.type === "start") replayHistory(state);
			return {};
		} catch (error) {
			if (error instanceof RequestError) throw error;
			throw RequestError.invalidParams(error instanceof Error ? error.message : String(error));
		}
	});

	app.onRequest(methods.agent.session.close, async ({ params }) => {
		await closeSession(params.sessionId);
	});

	app.onRequest(methods.agent.session.prompt, ({ params, client }) => {
		const state = sessions.get(params.sessionId);
		if (state === undefined) throw RequestError.invalidParams(`Unknown session "${params.sessionId}"`);
		if (state.turnActive)
			throw RequestError.invalidRequest(`Session "${params.sessionId}" is already processing a prompt`);
		const { text, images } = promptToText(params.prompt);
		const messageId = crypto.randomUUID();
		// Queue the response before the turn starts: the first notify lands
		// after this handler returns, so `{messageId}` is written first.
		const turn = Promise.resolve()
			.then(() =>
				client.notify(methods.client.session.update, {
					sessionId: params.sessionId,
					update: { sessionUpdate: "user_message", messageId, content: params.prompt },
				}),
			)
			.then(() => runTurn(state, text, images.length > 0 ? images : undefined))
			.catch((error: unknown) => {
				console.error(`[acp] turn failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		void turn;
		return { messageId };
	});

	app.onNotification(methods.agent.session.cancel, ({ params }) => {
		const state = sessions.get(params.sessionId);
		if (state === undefined) return;
		state.cancelling = true;
		void state.runtime.session.abort().catch((error: unknown) => {
			console.error(`[acp] cancel failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});

	const disposeAll = async (): Promise<void> => {
		const live = [...sessions.values()];
		sessions.clear();
		for (const state of live) {
			state.unsubscribe();
			await state.runtime.session.abort();
			await state.runtime.dispose();
		}
		if (initial !== undefined) {
			await initial.dispose();
			initial = undefined;
		}
	};

	return { app, disposeAll };
}

export async function runAcpMode(
	initialRuntime: AgentSessionRuntime,
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: AcpModeOptions,
): Promise<never> {
	takeOverStdout();
	const { app, disposeAll } = createAcpApp(initialRuntime, createRuntime, options);
	const output = new WritableStream<Uint8Array>({
		write(chunk) {
			writeRawStdout(new TextDecoder().decode(chunk));
		},
	});
	const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	const connection = app.connect(ndJsonStream(output, input));

	process.stdin.on("end", () => {
		void disposeAll().finally(() => {
			process.exit(0);
		});
	});

	await connection.closed;
	await disposeAll();
	process.exit(0);
}

function assertUsableModel(session: AgentSession): void {
	if (session.model === undefined) throw new Error(formatNoModelsAvailableMessage());
}

/**
 * Map pi's end-of-turn signals to an ACP stop reason. `aborted` is
 * authoritative: when abort lands on a tool boundary the last assistant
 * message may read `error`, but the turn was cancelled.
 */
function stopReasonFor(state: AcpSession, aborted: boolean): StopReason {
	if (aborted) return "cancelled";
	for (let i = state.runtime.session.messages.length - 1; i >= 0; i--) {
		const message = state.runtime.session.messages[i];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return "error";
		if (message.stopReason === "length") return "max_tokens";
		return "end_turn";
	}
	return "end_turn";
}

function lastAssistantError(session: AgentSession): string | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role === "assistant") return message.errorMessage;
	}
	return undefined;
}

function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function toolResultText(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	if (!("content" in result) || !Array.isArray(result.content)) return "";
	const parts: string[] = [];
	for (const block of result.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("\n");
}

function promptToText(prompt: readonly ContentBlock[]): { text: string; images: PiImageContent[] } {
	const parts: string[] = [];
	const images: PiImageContent[] = [];
	for (const block of prompt) {
		if (ContentBlockGuard.isText(block)) {
			parts.push(block.text);
		} else if (ContentBlockGuard.isImage(block)) {
			images.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else if (ContentBlockGuard.isResourceLink(block)) {
			parts.push(block.uri);
		} else if (ContentBlockGuard.isResource(block)) {
			const resource = block.resource;
			if ("text" in resource) {
				parts.push(`[${resource.uri}]\n${resource.text}`);
			} else {
				parts.push(resource.uri);
			}
		}
	}
	return { text: parts.join("\n"), images };
}

/** Title, kind, and locations for a pi tool call. Locations resolve against `cwd`. */
function describeToolCall(
	toolName: string,
	input: unknown,
	cwd: string,
): { title: string; kind: ToolKind; locations: ToolCallLocation[] } {
	const path = stringField(input, "path") ?? stringField(input, "file_path");
	const at = (line?: number): ToolCallLocation[] =>
		path === undefined ? [] : [{ path: resolvePath(path, cwd), ...(line === undefined ? {} : { line }) }];
	switch (toolName) {
		case "read": {
			const offset = numberField(input, "offset");
			const limit = numberField(input, "limit");
			const range =
				offset !== undefined || limit !== undefined
					? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
					: "";
			return {
				title: path !== undefined ? `Read ${path}${range}` : "Read file",
				kind: "read",
				locations: at(offset),
			};
		}
		case "edit":
			return { title: path !== undefined ? `Edit ${path}` : "Edit file", kind: "edit", locations: at() };
		case "write":
			return { title: path !== undefined ? `Write ${path}` : "Write file", kind: "edit", locations: at() };
		case "grep": {
			const pattern = stringField(input, "pattern");
			return {
				title: pattern !== undefined ? `Search for "${pattern}"${path ? ` in ${path}` : ""}` : "Search files",
				kind: "search",
				locations: at(),
			};
		}
		case "find": {
			const pattern = stringField(input, "pattern");
			return {
				title: pattern !== undefined ? `Find ${pattern}${path ? ` in ${path}` : ""}` : "Find files",
				kind: "search",
				locations: at(),
			};
		}
		case "ls":
			return { title: path !== undefined ? `List ${path}` : "List directory", kind: "read", locations: at() };
		case "bash":
		case "powershell": {
			const firstLine = stringField(input, "command")?.split("\n", 1)[0]?.trim();
			return {
				title:
					firstLine !== undefined && firstLine.length > 0
						? `$ ${firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine}`
						: `Run ${toolName}`,
				kind: "execute",
				locations: [],
			};
		}
		default:
			return { title: toolName, kind: "other", locations: at() };
	}
}

function stringField(input: unknown, name: string): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	if (!(name in input)) return undefined;
	const value = (input as Record<string, unknown>)[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(input: unknown, name: string): number | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	if (!(name in input)) return undefined;
	const value = (input as Record<string, unknown>)[name];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
