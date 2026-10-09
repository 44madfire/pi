/**
 * ACP mode protocol tests: an SDK ClientApp drives `createAcpApp` in-process
 * over a direct connection, asserting on the `session/update` stream.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AvailableCommand,
	ClientContext,
	NewSessionResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionUpdate,
	StopReason,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
	client,
	methods,
	PROTOCOL_VERSION,
	SessionConfigOption as SessionConfigOptionGuard,
	ToolCallContent,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { applyPatch } from "diff";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ToolCallEvent, ToolCallEventResult } from "../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createAcpApp } from "../src/modes/acp/acp-mode.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

type UpdateOf<T extends SessionUpdate["sessionUpdate"]> = Extract<SessionUpdate, { sessionUpdate: T }>;

function filterUpdates<T extends SessionUpdate["sessionUpdate"]>(
	updates: readonly SessionUpdate[],
	kind: T,
): Array<UpdateOf<T>> {
	return updates.filter((update): update is UpdateOf<T> => update.sessionUpdate === kind);
}

function states(updates: readonly SessionUpdate[]): string[] {
	return filterUpdates(updates, "state_update").map((update) =>
		update.state === "idle" ? `idle:${update.stopReason ?? "?"}` : update.state,
	);
}

interface Scenario {
	harness: Harness;
	ctx: ClientContext;
	sessionId: string;
	updates: SessionUpdate[];
	initializeResponse: { protocolVersion: number; info: { name: string }; capabilities?: unknown };
	stop: () => Promise<void>;
}

async function startScenario(options: {
	responses: Parameters<Harness["setResponses"]>[0];
	tools?: AgentTool[];
	approveAll?: boolean;
	onPermission?: (request: RequestPermissionRequest) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
	permissionRequests?: RequestPermissionRequest[];
	harnessOptions?: Parameters<typeof createHarness>[0];
	newResponse?: (response: NewSessionResponse) => void;
}): Promise<Scenario> {
	let gateHook: ((sessionId: string, event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>) | undefined;
	const harness = await createHarness({
		tools: options.tools,
		...options.harnessOptions,
		extensionFactories: [
			{
				name: "acp-gate-test",
				hidden: true,
				factory: (pi) => {
					pi.on("tool_call", (event, ctx) => gateHook?.(ctx.sessionManager.getSessionId(), event));
				},
			},
		],
	});
	harness.setResponses(options.responses);
	const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("tests create no extra runtimes");
	};
	const initialRuntime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		createRuntime,
	);
	const { app, disposeAll, handleToolCall } = createAcpApp(initialRuntime, createRuntime, {
		...(options.approveAll === true ? { approveAll: true } : {}),
	});
	gateHook = handleToolCall;
	const updates: SessionUpdate[] = [];
	const clientApp = client({ name: "acp-mode-test" })
		.onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params.update);
		})
		.onRequest(methods.client.session.requestPermission, ({ params }) => {
			options.permissionRequests?.push(params);
			if (options.onPermission !== undefined) return options.onPermission(params);
			return { outcome: { outcome: "selected", optionId: "allow_once" } };
		});
	const connection = clientApp.connect(app);
	const ctx = connection.agent;
	const initializeResponse = await ctx.request(methods.agent.initialize, {
		protocolVersion: PROTOCOL_VERSION,
		info: { name: "test", version: "0.0.0" },
	});
	const created = await ctx.request(methods.agent.session.new, { cwd: harness.tempDir });
	options.newResponse?.(created);
	return {
		harness,
		ctx,
		sessionId: created.sessionId,
		updates,
		initializeResponse: initializeResponse as unknown as Scenario["initializeResponse"],
		stop: async () => {
			connection.close();
			await disposeAll();
			harness.cleanup();
		},
	};
}

async function waitForIdle(updates: SessionUpdate[]): Promise<StopReason | null | undefined> {
	for (let i = 0; i < 300; i++) {
		const idles = updates.filter(
			(update): update is Extract<SessionUpdate, { sessionUpdate: "state_update"; state: "idle" }> =>
				update.sessionUpdate === "state_update" && update.state === "idle",
		);
		if (idles.length > 0) return idles.at(-1)?.stopReason;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for idle; states: ${states(updates).join(",")}`);
}

/**
 * Wait for `count` updates at `start` (the updates length taken before the
 * `session/resume` call). The in-process stream may deliver already-queued
 * replay notifies before the resume response resolves.
 */
async function waitForUpdates(updates: SessionUpdate[], start: number, count: number): Promise<SessionUpdate[]> {
	for (let i = 0; i < 200 && updates.length < start + count; i++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (updates.length < start + count) {
		throw new Error(`timed out waiting for ${count} updates; got ${updates.length - start}`);
	}
	return updates.slice(start, start + count);
}

describe("acp mode", () => {
	const stops: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (stops.length > 0) {
			await stops.pop()?.();
		}
	});

	it("initializes with session capabilities and creates a session", async () => {
		const scenario = await startScenario({ responses: [] });
		stops.push(scenario.stop);
		expect(scenario.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(scenario.initializeResponse.info.name).toContain("acp");
		expect(scenario.initializeResponse.capabilities).toMatchObject({ session: expect.anything() });
		expect(typeof scenario.sessionId).toBe("string");
	});

	it("streams text and thinking chunks, then idles with end_turn", async () => {
		const scenario = await startScenario({
			responses: [fauxAssistantMessage([fauxThinking("hmm"), { type: "text", text: "hello there" }])],
		});
		stops.push(scenario.stop);

		const response = await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "hi" }],
		});
		expect(typeof response.messageId).toBe("string");
		expect(await waitForIdle(scenario.updates)).toBe("end_turn");

		expect(states(scenario.updates)[0]).toBe("running");
		expect(states(scenario.updates).at(-1)).toBe("idle:end_turn");
		const texts = filterUpdates(scenario.updates, "agent_message_chunk");
		expect(texts.length).toBeGreaterThan(0);
		expect(texts.map((update) => update.messageId)).toEqual(texts.map(() => texts[0]?.messageId));
		expect(texts.map((update) => (update.content.type === "text" ? update.content.text : "")).join("")).toBe(
			"hello there",
		);
		const thoughts = filterUpdates(scenario.updates, "agent_thought_chunk");
		expect(thoughts.map((update) => (update.content.type === "text" ? update.content.text : "")).join("")).toBe(
			"hmm",
		);
		expect(filterUpdates(scenario.updates, "usage_update")).toHaveLength(1);
	});

	it("reports a tool call pending/in_progress/completed with text output", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `saw ${text}` }], details: {} };
			},
		};
		const scenario = await startScenario({
			tools: [echo],
			responses: [
				fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "run it" }],
		});
		expect(await waitForIdle(scenario.updates)).toBe("end_turn");

		const toolCalls = filterUpdates(scenario.updates, "tool_call_update");
		const first = toolCalls[0];
		if (first === undefined) throw new Error("expected a tool call");
		const card = toolCalls.filter((update) => update.toolCallId === first.toolCallId);
		expect(card.map((update) => update.status)).toEqual(["pending", "in_progress", "completed"]);
		expect(card[0]).toMatchObject({ name: "echo", title: "echo", kind: "other", rawInput: { text: "hi" } });
		expect(card.at(-1)).toMatchObject({
			rawOutput: "saw hi",
			content: [{ type: "content", content: { type: "text", text: "saw hi" } }],
		});
	});

	it("reports a failing tool as failed", async () => {
		const boom: AgentTool = {
			name: "boom",
			label: "Boom",
			description: "boom",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("kaput");
			},
		};
		const scenario = await startScenario({
			tools: [boom],
			responses: [
				fauxAssistantMessage([fauxToolCall("boom", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "run it" }],
		});
		expect(await waitForIdle(scenario.updates)).toBe("end_turn");

		const ends = filterUpdates(scenario.updates, "tool_call_update").filter((update) => update.status === "failed");
		expect(ends).toHaveLength(1);
	});

	it("cancels a turn with stop reason cancelled", async () => {
		const { promise: toolStarted, resolve: markToolStarted } = Promise.withResolvers<void>();
		const hanging: AgentTool = {
			name: "hanging",
			label: "Hanging",
			description: "hanging",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				markToolStarted();
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const scenario = await startScenario({
			tools: [hanging],
			responses: [
				fauxAssistantMessage([fauxToolCall("hanging", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "hang" }],
		});
		await toolStarted;
		await scenario.ctx.notify(methods.agent.session.cancel, { sessionId: scenario.sessionId });
		expect(await waitForIdle(scenario.updates)).toBe("cancelled");
	});

	it("reports a provider error as an agent message plus idle error", async () => {
		const scenario = await startScenario({
			responses: [fauxAssistantMessage("nope", { stopReason: "error", errorMessage: "provider blew up" })],
		});
		stops.push(scenario.stop);

		await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "hi" }],
		});
		expect(await waitForIdle(scenario.updates)).toBe("error");

		const errors = filterUpdates(scenario.updates, "agent_message");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.content).toEqual([{ type: "text", text: "provider blew up" }]);
	});

	it("lists, resumes, and closes sessions", async () => {
		const scenario = await startScenario({ responses: [fauxAssistantMessage("hi")] });
		stops.push(scenario.stop);

		const listed = await scenario.ctx.request(methods.agent.session.list, { cwd: scenario.harness.tempDir });
		expect(listed.sessions.map((session) => session.sessionId)).toContain(scenario.sessionId);

		const resumed = await scenario.ctx.request(methods.agent.session.resume, {
			sessionId: scenario.sessionId,
			cwd: scenario.harness.tempDir,
		});
		expect(resumed.configOptions?.map((option) => option.configId)).toEqual(["model", "thought_level"]);

		await scenario.ctx.request(methods.agent.session.close, { sessionId: scenario.sessionId });
		await expect(
			scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "hi" }],
			}),
		).rejects.toThrow();
	});

	it("keeps stdout-hygiene: console.log in a tool does not break frames", async () => {
		const noisy: AgentTool = {
			name: "noisy",
			label: "Noisy",
			description: "noisy",
			parameters: Type.Object({}),
			execute: async () => {
				console.log("NOISE on stdout");
				return { content: [{ type: "text", text: "quiet result" }], details: {} };
			},
		};
		const scenario = await startScenario({
			tools: [noisy],
			responses: [
				fauxAssistantMessage([fauxToolCall("noisy", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "run it" }],
		});
		expect(await waitForIdle(scenario.updates)).toBe("end_turn");
		const ends = filterUpdates(scenario.updates, "tool_call_update").filter(
			(update) => update.status === "completed",
		);
		expect(ends).toHaveLength(1);
	});

	describe("tool approvals", () => {
		const scriptedTool = (name: string, text: string): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => ({ content: [{ type: "text", text }], details: {} }),
		});

		const selected = (optionId: string): RequestPermissionResponse => ({
			outcome: { outcome: "selected", optionId },
		});

		it("asks once for a gated tool, shows the card only after approval, then completes", async () => {
			const permissionRequests: RequestPermissionRequest[] = [];
			const seenCardBeforeAnswer = { value: false };
			const scenario = await startScenario({
				tools: [scriptedTool("bash", "ran it")],
				responses: [
					fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				],
				permissionRequests,
				onPermission: () => {
					seenCardBeforeAnswer.value = filterUpdates(scenario.updates, "tool_call_update").length > 0;
					return selected("allow_once");
				},
			});
			stops.push(scenario.stop);

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "run it" }],
			});
			expect(await waitForIdle(scenario.updates)).toBe("end_turn");

			expect(permissionRequests).toHaveLength(1);
			expect(permissionRequests[0]?.options.map((option) => option.optionId)).toEqual([
				"allow_once",
				"allow_always",
				"reject_once",
				"reject_always",
			]);
			expect(permissionRequests[0]?.subject?.type).toBe("tool_call");
			expect(seenCardBeforeAnswer.value).toBe(false);
			expect(states(scenario.updates)).toContain("requires_action");
			const card = filterUpdates(scenario.updates, "tool_call_update");
			expect(card.map((update) => update.status)).toEqual(["pending", "in_progress", "completed"]);
			expect(card[0]).toMatchObject({ name: "bash", rawInput: { command: "echo hi" } });
		});

		it("allow_always skips the second ask for the same first command word", async () => {
			const permissionRequests: RequestPermissionRequest[] = [];
			const scenario = await startScenario({
				tools: [scriptedTool("bash", "ok")],
				responses: [
					fauxAssistantMessage(
						[fauxToolCall("bash", { command: "git status" }), fauxToolCall("bash", { command: "git diff" })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("done"),
				],
				permissionRequests,
				onPermission: (request) => {
					const subject = request.subject;
					const toolCall =
						subject !== null && subject !== undefined && subject.type === "tool_call" && "toolCall" in subject
							? subject.toolCall
							: undefined;
					const rawInput =
						typeof toolCall === "object" && toolCall !== null && "rawInput" in toolCall
							? toolCall.rawInput
							: undefined;
					const command =
						typeof rawInput === "object" && rawInput !== null && "command" in rawInput
							? String(rawInput.command)
							: "";
					return selected(command === "git status" ? "allow_always" : "allow_once");
				},
			});
			stops.push(scenario.stop);

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "run both" }],
			});
			expect(await waitForIdle(scenario.updates)).toBe("end_turn");
			expect(permissionRequests).toHaveLength(1);
		});

		it("reject fails the card and shows the model the reason", async () => {
			const scenario = await startScenario({
				tools: [scriptedTool("edit", "never runs")],
				responses: [
					fauxAssistantMessage([fauxToolCall("edit", { path: "a.txt" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				],
				onPermission: () => selected("reject_once"),
			});
			stops.push(scenario.stop);

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "edit it" }],
			});
			expect(await waitForIdle(scenario.updates)).toBe("end_turn");

			const card = filterUpdates(scenario.updates, "tool_call_update");
			expect(card.map((update) => update.status)).toEqual(["pending", "in_progress", "failed"]);
			expect(card.at(-1)?.rawOutput).toContain("rejected");
			const result = scenario.harness.session.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === "edit",
			);
			expect(result?.role).toBe("toolResult");
			if (result?.role === "toolResult")
				expect(result.content.map((block) => (block.type === "text" ? block.text : "")).join("")).toContain(
					"rejected",
				);
		});

		it("does not ask for read tools", async () => {
			const permissionRequests: RequestPermissionRequest[] = [];
			const scenario = await startScenario({
				tools: [scriptedTool("read", "file contents")],
				responses: [
					fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				],
				permissionRequests,
			});
			stops.push(scenario.stop);

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "read it" }],
			});
			expect(await waitForIdle(scenario.updates)).toBe("end_turn");
			expect(permissionRequests).toHaveLength(0);
			expect(states(scenario.updates)).not.toContain("requires_action");
		});

		it("cancel while asking settles promptly as cancelled", async () => {
			const { promise: askOpened, resolve: markAskOpened } = Promise.withResolvers<void>();
			const scenario = await startScenario({
				tools: [scriptedTool("bash", "never runs")],
				responses: [
					fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				],
				onPermission: () => {
					markAskOpened();
					return new Promise<RequestPermissionResponse>(() => {});
				},
			});
			stops.push(scenario.stop);

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "hang" }],
			});
			await askOpened;
			await scenario.ctx.notify(methods.agent.session.cancel, { sessionId: scenario.sessionId });
			expect(await waitForIdle(scenario.updates)).toBe("cancelled");
		});

		it("answers an extension select through request_permission", async () => {
			const permissionRequests: RequestPermissionRequest[] = [];
			const scenario = await startScenario({
				responses: [fauxAssistantMessage("done")],
				permissionRequests,
				onPermission: (request) => {
					const option = request.options.find((candidate) => candidate.name === "beta");
					return selected(option?.optionId ?? "0");
				},
			});
			stops.push(scenario.stop);

			const ui = scenario.harness.session.extensionRunner.getUIContext();
			const pending = ui.select("Pick one", ["alpha", "beta"]);
			await vi.waitFor(() => expect(permissionRequests).toHaveLength(1));
			expect(permissionRequests[0]?.options).toEqual([
				{ optionId: "0", name: "alpha", kind: "other" },
				{ optionId: "1", name: "beta", kind: "other" },
			]);
			await expect(pending).resolves.toBe("beta");
		});

		it("--approve-all skips asks", async () => {
			const permissionRequests: RequestPermissionRequest[] = [];
			const scenario = await startScenario({
				tools: [scriptedTool("bash", "ran free")],
				responses: [
					fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf x" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				],
				approveAll: true,
				permissionRequests,
			});
			stops.push(scenario.stop);

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "run it" }],
			});
			expect(await waitForIdle(scenario.updates)).toBe("end_turn");
			expect(permissionRequests).toHaveLength(0);
			const card = filterUpdates(scenario.updates, "tool_call_update");
			expect(card.map((update) => update.status)).toEqual(["pending", "in_progress", "completed"]);
		});
	});

	describe("edit/write diffs", () => {
		it("attaches a modify change with a valid git_patch to a successful edit", async () => {
			const scenario = await startScenario({
				approveAll: true,
				responses: [
					fauxAssistantMessage(
						[fauxToolCall("edit", { path: "note.txt", edits: [{ oldText: "original", newText: "CHANGED" }] })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("done"),
				],
			});
			stops.push(scenario.stop);
			writeFileSync(join(scenario.harness.tempDir, "note.txt"), "original\n");

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "edit it" }],
			});
			expect(await waitForIdle(scenario.updates)).toBe("end_turn");

			const ends = filterUpdates(scenario.updates, "tool_call_update").filter(
				(update) => update.status === "completed",
			);
			expect(ends).toHaveLength(1);
			const end = ends[0];
			expect(end?.content).toHaveLength(2);
			const diff = end?.content?.find((item) => ToolCallContent.isDiff(item));
			if (diff === undefined || !ToolCallContent.isDiff(diff)) throw new Error("expected diff content");
			expect(diff.changes).toEqual([{ operation: "modify", path: join(scenario.harness.tempDir, "note.txt") }]);
			expect(diff.patch?.format).toBe("git_patch");
			const patch = diff.patch?.text ?? "";
			expect(patch.startsWith("diff --git")).toBe(true);
			expect(applyPatch("original\n", patch)).toBe("CHANGED\n");
		});

		it("reports write as add for new files and modify for existing ones, without a patch", async () => {
			const scenario = await startScenario({
				approveAll: true,
				responses: [
					fauxAssistantMessage([fauxToolCall("write", { path: "new.txt", content: "one\n" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage([fauxToolCall("write", { path: "new.txt", content: "two\n" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				],
			});
			stops.push(scenario.stop);

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "write it twice" }],
			});
			expect(await waitForIdle(scenario.updates)).toBe("end_turn");

			const target = join(scenario.harness.tempDir, "new.txt");
			const ends = filterUpdates(scenario.updates, "tool_call_update").filter(
				(update) => update.status === "completed",
			);
			expect(ends).toHaveLength(2);
			const diffs = ends.map((end) => end.content?.find((item) => ToolCallContent.isDiff(item)));
			const [first, second] = diffs;
			if (first === undefined || second === undefined) throw new Error("expected diff content");
			if (!ToolCallContent.isDiff(first) || !ToolCallContent.isDiff(second)) {
				throw new Error("expected diff content");
			}
			expect(first.changes).toEqual([{ operation: "add", path: target }]);
			expect(first.patch).toBeUndefined();
			expect(second.changes).toEqual([{ operation: "modify", path: target }]);
			expect(second.patch).toBeUndefined();
		});

		it("carries no diff on a failed edit", async () => {
			const scenario = await startScenario({
				approveAll: true,
				responses: [
					fauxAssistantMessage(
						[fauxToolCall("edit", { path: "note.txt", edits: [{ oldText: "missing", newText: "x" }] })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("done"),
				],
			});
			stops.push(scenario.stop);
			writeFileSync(join(scenario.harness.tempDir, "note.txt"), "original\n");

			await scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "edit it" }],
			});
			expect(await waitForIdle(scenario.updates)).toBe("end_turn");

			const ends = filterUpdates(scenario.updates, "tool_call_update").filter(
				(update) => update.status === "failed",
			);
			expect(ends).toHaveLength(1);
			expect(ends[0]?.content?.some((item) => item.type === "diff")).toBe(false);
		});
	});
});

describe("acp resume replay", () => {
	const stops: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (stops.length > 0) {
			await stops.pop()?.();
		}
	});

	it("replays text, thinking, and tool calls as the live entities, in order", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `saw ${text}` }], details: {} };
			},
		};
		const scenario = await startScenario({
			tools: [echo],
			responses: [
				fauxAssistantMessage(
					[
						fauxThinking("thinking it over"),
						{ type: "text", text: "live text here" },
						fauxToolCall("echo", { text: "hi" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "run it" }],
		});
		expect(await waitForIdle(scenario.updates)).toBe("end_turn");
		const live = scenario.updates.slice();
		const replayStart = scenario.updates.length;
		await scenario.ctx.request(methods.agent.session.resume, {
			sessionId: scenario.sessionId,
			cwd: scenario.harness.tempDir,
			replayFrom: { type: "start" },
		});
		const replayed = await waitForUpdates(scenario.updates, replayStart, 5);
		expect(replayed).toHaveLength(5);
		expect(replayed.map((update) => update.sessionUpdate)).toEqual([
			"user_message",
			"agent_message",
			"agent_thought",
			"tool_call_update",
			"agent_message",
		]);

		// Whole replayed messages carry the same content the live chunks streamed.
		expect(filterUpdates(replayed, "user_message").map((update) => update.content)).toEqual(
			filterUpdates(live, "user_message").map((update) => update.content),
		);
		const wholeText = (updates: readonly SessionUpdate[], kind: "agent_message" | "agent_thought"): string[] =>
			filterUpdates(updates, kind).map((update) =>
				(update.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join(""),
			);
		const chunkedText = (
			updates: readonly SessionUpdate[],
			kind: "agent_message_chunk" | "agent_thought_chunk",
		): string[] => {
			const groups = new Map<string, string>();
			for (const chunk of filterUpdates(updates, kind)) {
				if (chunk.content.type !== "text") continue;
				groups.set(chunk.messageId, (groups.get(chunk.messageId) ?? "") + chunk.content.text);
			}
			return [...groups.values()];
		};
		expect(wholeText(replayed, "agent_message")).toEqual(chunkedText(live, "agent_message_chunk"));
		expect(wholeText(replayed, "agent_thought")).toEqual(chunkedText(live, "agent_thought_chunk"));

		// The replayed card equals the live card's merged updates, under the same tool id.
		const replayedCard = filterUpdates(replayed, "tool_call_update");
		expect(replayedCard).toHaveLength(1);
		expect(replayedCard[0]).toEqual(Object.assign({}, ...filterUpdates(live, "tool_call_update")));

		// Replay is deterministic: a second resume emits identical updates.
		const secondStart = scenario.updates.length;
		await scenario.ctx.request(methods.agent.session.resume, {
			sessionId: scenario.sessionId,
			cwd: scenario.harness.tempDir,
			replayFrom: { type: "start" },
		});
		expect(await waitForUpdates(scenario.updates, secondStart, 5)).toEqual(replayed);
	});

	it("replays a failing tool as failed", async () => {
		const boom: AgentTool = {
			name: "boom",
			label: "Boom",
			description: "boom",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("kaput");
			},
		};
		const scenario = await startScenario({
			tools: [boom],
			responses: [
				fauxAssistantMessage([fauxToolCall("boom", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "run it" }],
		});
		expect(await waitForIdle(scenario.updates)).toBe("end_turn");
		const live = scenario.updates.slice();
		const replayStart = scenario.updates.length;
		await scenario.ctx.request(methods.agent.session.resume, {
			sessionId: scenario.sessionId,
			cwd: scenario.harness.tempDir,
			replayFrom: { type: "start" },
		});
		const replayed = await waitForUpdates(scenario.updates, replayStart, 3);
		expect(replayed.map((update) => update.sessionUpdate)).toEqual([
			"user_message",
			"tool_call_update",
			"agent_message",
		]);
		const replayedCard = filterUpdates(replayed, "tool_call_update");
		expect(replayedCard).toHaveLength(1);
		expect(replayedCard[0]?.status).toBe("failed");
		expect(replayedCard[0]).toEqual(Object.assign({}, ...filterUpdates(live, "tool_call_update")));
	});

	it("rejects unknown replay cursors", async () => {
		const scenario = await startScenario({ responses: [] });
		stops.push(scenario.stop);
		await expect(
			scenario.ctx.request(methods.agent.session.resume, {
				sessionId: scenario.sessionId,
				cwd: scenario.harness.tempDir,
				replayFrom: { type: "_custom" },
			}),
		).rejects.toThrow();
	});
});

function selectValues(option: SessionConfigOption): string[] {
	if (!SessionConfigOptionGuard.isSelect(option)) throw new Error(`expected select, got ${option.type}`);
	return option.options.map((entry) => ("options" in entry ? entry.groupId : entry.value));
}

function selectCurrent(option: SessionConfigOption): string {
	if (!SessionConfigOptionGuard.isSelect(option)) throw new Error(`expected select, got ${option.type}`);
	return option.currentValue;
}

async function waitForConfigUpdate(updates: SessionUpdate[], skip = 0): Promise<SessionConfigOption[]> {
	for (let i = 0; i < 100; i++) {
		const update = filterUpdates(updates, "config_option_update").at(skip);
		if (update !== undefined) return update.configOptions;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for config_option_update");
}

describe("acp config options and commands", () => {
	const stops: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (stops.length > 0) {
			await stops.pop()?.();
		}
	});

	it("returns model and thought_level config options on session/new", async () => {
		let created: NewSessionResponse | undefined;
		const scenario = await startScenario({
			responses: [],
			harnessOptions: { models: [{ id: "faux-1", name: "One", reasoning: true }] },
			newResponse: (response) => {
				created = response;
			},
		});
		stops.push(scenario.stop);

		const options = created?.configOptions;
		if (options === undefined) throw new Error("expected configOptions on session/new");
		expect(options.map((option) => option.configId)).toEqual(["model", "thought_level"]);
		const [model, thought] = options;
		if (model === undefined || thought === undefined) throw new Error("expected two config options");
		expect(model.category).toBe("model");
		expect(selectCurrent(model)).toBe("faux/faux-1");
		expect(selectValues(model)).toEqual(["faux/faux-1"]);
		expect(thought.category).toBe("thought_level");
		expect(selectCurrent(thought)).toBe(scenario.harness.session.thinkingLevel);
		expect(selectValues(thought)).toEqual(scenario.harness.session.getAvailableThinkingLevels());
	});

	it("sets thought_level, refreshes model levels, and rejects invalid values", async () => {
		const scenario = await startScenario({
			responses: [],
			harnessOptions: {
				models: [
					{ id: "faux-1", name: "One", reasoning: true },
					{ id: "faux-2", name: "Two", reasoning: false },
				],
			},
		});
		stops.push(scenario.stop);

		const set = await scenario.ctx.request(methods.agent.session.setConfigOption, {
			sessionId: scenario.sessionId,
			configId: "thought_level",
			type: "id",
			value: "low",
		});
		const thought = set.configOptions.find((option) => option.configId === "thought_level");
		if (thought === undefined) throw new Error("expected thought_level in response");
		expect(selectCurrent(thought)).toBe("low");
		expect(scenario.harness.session.thinkingLevel).toBe("low");

		const switched = await scenario.ctx.request(methods.agent.session.setConfigOption, {
			sessionId: scenario.sessionId,
			configId: "model",
			type: "id",
			value: "faux/faux-2",
		});
		const model = switched.configOptions.find((option) => option.configId === "model");
		const clamped = switched.configOptions.find((option) => option.configId === "thought_level");
		if (model === undefined || clamped === undefined) throw new Error("expected model and thought_level");
		expect(selectCurrent(model)).toBe("faux/faux-2");
		expect(selectValues(clamped)).toEqual(["off"]);
		expect(selectCurrent(clamped)).toBe("off");

		await expect(
			scenario.ctx.request(methods.agent.session.setConfigOption, {
				sessionId: scenario.sessionId,
				configId: "thought_level",
				type: "id",
				value: "ultra",
			}),
		).rejects.toThrow();
		await expect(
			scenario.ctx.request(methods.agent.session.setConfigOption, {
				sessionId: scenario.sessionId,
				configId: "mode",
				type: "id",
				value: "x",
			}),
		).rejects.toThrow();
	});

	it("emits config_option_update when the model changes elsewhere", async () => {
		const scenario = await startScenario({
			responses: [],
			harnessOptions: {
				models: [
					{ id: "faux-1", name: "One", reasoning: true },
					{ id: "faux-2", name: "Two", reasoning: false },
				],
			},
		});
		stops.push(scenario.stop);
		scenario.harness.session.setThinkingLevel("high");
		await waitForConfigUpdate(scenario.updates);
		const seen = filterUpdates(scenario.updates, "config_option_update").length;

		const model = scenario.harness.getModel("faux-2");
		if (model === undefined) throw new Error("expected faux-2");
		await scenario.harness.session.setModel(model);

		// Updates deliver async, so wait for a new one past the high-level update.
		const options = await waitForConfigUpdate(scenario.updates, seen);
		const current = options.find((option) => option.configId === "model");
		if (current === undefined) throw new Error("expected model option");
		expect(selectCurrent(current)).toBe("faux/faux-2");
	});

	it("advertises a prompt template and executes it through prompt", async () => {
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({
				prompts: [
					{
						name: "review",
						description: "Review template",
						argumentHint: "<file>",
						content: "Review this code: $1",
						filePath: "/virtual/review.md",
						sourceInfo: createSyntheticSourceInfo("/virtual/review.md", { source: "local" }),
					},
				],
				diagnostics: [],
			}),
		};
		let commands: AvailableCommand[] | undefined;
		const scenario = await startScenario({
			responses: [],
			harnessOptions: { resourceLoader },
			newResponse: (response) => {
				commands = response.availableCommands;
			},
		});
		stops.push(scenario.stop);
		if (commands === undefined) throw new Error("expected availableCommands on session/new");
		expect(commands).toContainEqual({
			name: "review",
			description: "Review template",
			input: { type: "text", hint: "<file>" },
		});

		let expanded = "";
		scenario.harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expanded = user === undefined ? "" : getMessageText(user);
				return fauxAssistantMessage("ok");
			},
		]);
		await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "/review src/index.ts" }],
		});
		expect(await waitForIdle(scenario.updates)).toBe("end_turn");
		expect(expanded).toBe("Review this code: src/index.ts");
	});
});
