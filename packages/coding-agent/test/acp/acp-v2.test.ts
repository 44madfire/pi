/**
 * P1 acceptance: in-process ACP v2 scenarios over the real agent.
 *
 * A v2 SDK ClientApp drives initialize/new/prompt against the wire adapter,
 * with the faux provider scripting tool calls. One test per PLAN P1 scenario.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ClientContext,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionUpdate,
	StopReason,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { client, methods } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createAcpSessionExtension } from "../../src/modes/acp/pi/session-extension.ts";
import type { AcpV2Runtime } from "../../src/modes/acp/wire/v2.ts";
import { createV2Runtime } from "../../src/modes/acp/wire/v2.ts";
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";

function selected(optionId: string): RequestPermissionResponse {
	return { outcome: { outcome: "selected", optionId } };
}

function filterUpdates<T extends SessionUpdate["sessionUpdate"]>(
	updates: readonly SessionUpdate[],
	kind: T,
): Array<Extract<SessionUpdate, { sessionUpdate: T }>> {
	return updates.filter(
		(update): update is Extract<SessionUpdate, { sessionUpdate: T }> => update.sessionUpdate === kind,
	);
}

function toolCallById(updates: readonly SessionUpdate[]): Map<string, ToolCallUpdate[]> {
	const byId = new Map<string, ToolCallUpdate[]>();
	for (const update of filterUpdates(updates, "tool_call_update")) {
		const list = byId.get(update.toolCallId);
		if (list === undefined) byId.set(update.toolCallId, [update]);
		else list.push(update);
	}
	return byId;
}

function stateSequence(updates: readonly SessionUpdate[]): string[] {
	return filterUpdates(updates, "state_update").map((update) =>
		update.state === "idle" ? `idle:${update.stopReason ?? "?"}` : update.state,
	);
}

function toolCallSubject(request: RequestPermissionRequest): {
	toolCallId: string;
	kind: string | null | undefined;
	rawInput: unknown;
	name?: string | null;
} {
	const subject = request.subject;
	if (subject?.type !== "tool_call") throw new Error("expected tool_call subject");
	const toolCall = (
		subject as unknown as {
			toolCall: { toolCallId: string; kind: string | null | undefined; rawInput: unknown; name?: string | null };
		}
	).toolCall;
	return toolCall;
}

interface TurnResult {
	updates: SessionUpdate[];
	stopReason: StopReason | null | undefined;
}

interface Scenario {
	harness: Harness;
	v2: AcpV2Runtime;
	ctx: ClientContext;
	sessionId: string;
	updates: SessionUpdate[];
	permissionRequests: RequestPermissionRequest[];
	waitForUpdate: () => Promise<void>;
}

async function startScenario(options: {
	setResponses: Parameters<Harness["setResponses"]>[0];
	onPermission?: (request: RequestPermissionRequest) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
	harnessOptions?: Parameters<typeof createHarness>[0];
}): Promise<Scenario & { stop: () => Promise<void> }> {
	const harness = await createHarness({
		...options.harnessOptions,
		extensionFactories: [...(options.harnessOptions?.extensionFactories ?? []), createAcpSessionExtension()],
	});
	harness.setResponses(options.setResponses);
	const cwd = harness.tempDir;
	const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("acceptance tests create no extra runtimes");
	};
	const initialRuntime = new AgentSessionRuntime(
		harness.session,
		{
			cwd,
			agentDir: cwd,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		createRuntime,
	);
	const v2 = createV2Runtime(initialRuntime, createRuntime, { approveAll: false });
	const updates: SessionUpdate[] = [];
	const permissionRequests: RequestPermissionRequest[] = [];
	let notifyWaiters: Array<() => void> = [];
	const waitForUpdate = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		notifyWaiters.push(resolve);
		return promise;
	};
	const clientApp = client({ name: "acceptance-client" })
		.onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params.update);
			const waiters = notifyWaiters;
			notifyWaiters = [];
			for (const waiter of waiters) waiter();
		})
		.onRequest(methods.client.session.requestPermission, ({ params }) => {
			permissionRequests.push(params);
			if (options.onPermission === undefined) return selected("allow_once");
			return options.onPermission(params);
		});
	const connection = clientApp.connect(v2.app);
	const ctx = connection.agent;
	await ctx.request(methods.agent.initialize, {
		protocolVersion: 2,
		info: { name: "acceptance", version: "0.0.0" },
		capabilities: {},
	});
	const created = await ctx.request(methods.agent.session.new, { cwd });
	return {
		harness,
		v2,
		ctx,
		sessionId: created.sessionId,
		updates,
		permissionRequests,
		waitForUpdate,
		stop: async () => {
			connection.close();
			await v2.disposeAll();
			harness.cleanup();
		},
	};
}

async function waitForIdle(
	scenario: Pick<Scenario, "updates" | "waitForUpdate">,
	timeoutMs = 15000,
): Promise<TurnResult> {
	// Integration test against the real agent run: the agent loop cannot run on
	// fake timers, so wait on the notification signal with a bounded timeout.
	const found = (): TurnResult | undefined => {
		const idles = filterUpdates(scenario.updates, "state_update").filter((update) => update.state === "idle");
		if (idles.length === 0) return undefined;
		const last = idles[idles.length - 1];
		if (last === undefined) return undefined;
		const stopReason = (last as unknown as { stopReason?: StopReason | null }).stopReason;
		return { updates: scenario.updates, stopReason };
	};
	const existing = found();
	if (existing !== undefined) return existing;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(`timed out waiting for idle; states: ${stateSequence(scenario.updates).join(",")}`);
		}
		const { promise, resolve } = Promise.withResolvers<"update" | "timeout">();
		const timer = setTimeout(() => resolve("timeout"), Math.min(5000, remaining));
		try {
			await Promise.race([scenario.waitForUpdate().then(() => resolve("update")), promise]);
		} finally {
			clearTimeout(timer);
		}
		const result = found();
		if (result !== undefined) return result;
	}
}

async function prompt(scenario: Scenario, text: string): Promise<TurnResult> {
	const response = await scenario.ctx.request(methods.agent.session.prompt, {
		sessionId: scenario.sessionId,
		prompt: [{ type: "text", text }],
	});
	expect(typeof response.messageId).toBe("string");
	return waitForIdle(scenario);
}

describe("acp v2 acceptance", () => {
	const stops: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (stops.length > 0) {
			const stop = stops.pop();
			if (stop !== undefined) await stop();
		}
	});

	it("a: gated bash allow_once — ask, run, terminal card, idle end_turn", async () => {
		const scenario = await startScenario({
			setResponses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo allow-once-hi" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		const result = await prompt(scenario, "run it");

		expect(result.stopReason).toBe("end_turn");
		expect(scenario.permissionRequests).toHaveLength(1);
		const request = scenario.permissionRequests[0];
		if (request === undefined) throw new Error("expected a permission request");
		expect(request.title.length).toBeGreaterThan(0);
		expect(request.subject?.type).toBe("tool_call");
		const subject = toolCallSubject(request);
		expect(subject.toolCallId.length).toBeGreaterThan(0);
		expect(subject.kind).toBe("execute");
		expect(subject.rawInput).toEqual({ command: "echo allow-once-hi" });
		expect(request.options.map((option) => option.optionId)).toEqual([
			"allow_once",
			"allow_always",
			"reject_once",
			"reject_always",
		]);

		const states = stateSequence(scenario.updates);
		expect(states[0]).toBe("running");
		expect(states).toContain("requires_action");
		expect(states.indexOf("requires_action")).toBeGreaterThan(0);
		expect(states.slice(states.indexOf("requires_action"))).toContain("running");
		expect(states.at(-1)).toBe("idle:end_turn");

		// The tool card is created only after the decision, then terminal output and completed.
		const toolCalls = toolCallById(scenario.updates);
		expect([...toolCalls.keys()]).toHaveLength(1);
		const card = [...toolCalls.values()][0];
		if (card === undefined) throw new Error("expected one tool card");
		expect(card.map((update) => update.status)).toEqual(["pending", "in_progress", "completed"]);
		expect(card[0]?.rawInput).toEqual({ command: "echo allow-once-hi" });
		expect(card[0]?.kind).toBe("execute");
		const terminals = filterUpdates(scenario.updates, "terminal_update");
		expect(terminals.length).toBeGreaterThanOrEqual(2);
		const terminalId = terminals[0]?.terminalId;
		expect(terminalId).toBeDefined();
		const decoded = filterUpdates(scenario.updates, "terminal_output_chunk")
			.filter((chunk) => chunk.terminalId === terminalId)
			.map((chunk) => Buffer.from(chunk.data, "base64").toString("utf-8"))
			.join("");
		expect(decoded).toContain("allow-once-hi");
		expect(card.at(-1)?.content).toEqual([{ type: "terminal", terminalId }]);
	});

	it("b: allow_always caches per first command word", async () => {
		const scenario = await startScenario({
			onPermission: (request) => {
				const input = request.subject?.type === "tool_call" ? toolCallSubject(request).rawInput : undefined;
				const command =
					typeof input === "object" && input !== null && "command" in input ? String(input.command) : "";
				return selected(command === "git status" ? "allow_always" : "allow_once");
			},
			setResponses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "git status" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("bash", { command: "git diff --stat" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo other-word" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		const result = await prompt(scenario, "run three");
		expect(result.stopReason).toBe("end_turn");
		// First asks (allow_always), second same-word runs silent, third different-word asks again.
		expect(scenario.permissionRequests).toHaveLength(2);
		const asks = scenario.permissionRequests.map((request) =>
			request.subject?.type === "tool_call" ? toolCallSubject(request).rawInput : undefined,
		);
		expect(asks).toEqual([{ command: "git status" }, { command: "echo other-word" }]);
	});

	it("c: reject_once blocks the tool and the card ends failed", async () => {
		const scenario = await startScenario({
			onPermission: () => selected("reject_once"),
			setResponses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo must-not-run" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		const result = await prompt(scenario, "run it");
		expect(result.stopReason).toBe("end_turn");
		expect(scenario.permissionRequests).toHaveLength(1);

		const toolResult = getToolResult(scenario.harness, "bash");
		expect(toolResult.isError).toBe(true);
		const text = toolResult.content
			.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain("rejected");

		const toolCalls = toolCallById(scenario.updates);
		const card = [...toolCalls.values()][0];
		if (card === undefined) throw new Error("expected one tool card");
		expect(card.map((update) => update.status)).toEqual(["pending", "failed"]);
		const endContent = card.at(-1)?.content;
		expect(endContent).toHaveLength(1);
		const first = endContent?.[0];
		expect(first?.type).toBe("content");
		if (first?.type !== "content") throw new Error("expected text content");
		const inner = (first as unknown as { content: { type: string; text?: string } }).content;
		expect(inner.type).toBe("text");
		expect(inner.text).toContain("rejected");
	});
	it("d: edit carries diff changes plus git_patch; read/grep do not ask", async () => {
		const replies = [
			fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "CHANGED", path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "note.txt", edits: [{ oldText: "original", newText: "CHANGED" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		];
		const scripted = (_c: unknown, _o: unknown, state: { callCount: number }) =>
			replies[Math.min(state.callCount - 1, replies.length - 1)];
		const scenario = await startScenario({
			setResponses: [scripted, scripted, scripted, scripted],
		});
		stops.push(scenario.stop);
		writeFileSync(join(scenario.harness.tempDir, "note.txt"), "original\n");
		const target = join(scenario.harness.tempDir, "note.txt");
		const result = await prompt(scenario, "read, search, edit");
		expect(result.stopReason).toBe("end_turn");

		// Only the edit asked.
		expect(scenario.permissionRequests).toHaveLength(1);
		const editRequest = scenario.permissionRequests[0];
		if (editRequest === undefined) throw new Error("expected a permission request");
		expect(toolCallSubject(editRequest).name).toBe("edit");

		const toolCalls = toolCallById(scenario.updates);
		const editCard = [...toolCalls.values()].find((card) => card[0]?.name === "edit");
		if (editCard === undefined) throw new Error("expected an edit card");
		expect(editCard.at(-1)?.status).toBe("completed");
		const diff = editCard.at(-1)?.content?.find((item) => item.type === "diff");
		expect(diff?.type).toBe("diff");
		if (diff?.type !== "diff") throw new Error("expected diff content");
		expect(diff.changes).toEqual([{ operation: "modify", path: target, fileType: "text" }]);
		const patch = (diff as unknown as { patch?: { format: string; text: string } }).patch;
		expect(patch?.format).toBe("git_patch");
		const patchText = patch?.text ?? "";
		expect(patchText).toContain("diff --git a/");
		expect(patchText).toContain(" b/");
		expect(patchText).toContain("-original");
		expect(patchText).toContain("+CHANGED");
	});

	it("e: cancel mid-tool reaches idle cancelled", async () => {
		const gate = Promise.withResolvers<void>();
		const sleeper: AgentTool = {
			name: "acp_sleeper",
			label: "Sleeper",
			description: "Sleeps until released or aborted",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				await new Promise<void>((resolve, reject) => {
					const onAbort = (): void => {
						signal?.removeEventListener("abort", onAbort);
						reject(new Error("aborted"));
					};
					if (signal?.aborted === true) {
						reject(new Error("aborted"));
						return;
					}
					signal?.addEventListener("abort", onAbort, { once: true });
					void gate.promise.then(() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					});
				});
				return { content: [{ type: "text", text: "slept" }], details: {} };
			},
		};
		const scenario = await startScenario({
			harnessOptions: { tools: [sleeper] },
			setResponses: [
				fauxAssistantMessage([fauxToolCall("acp_sleeper", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		const started = Promise.withResolvers<void>();
		const unsubscribe = scenario.harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "acp_sleeper") {
				unsubscribe();
				started.resolve();
			}
		});
		const response = await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "sleep" }],
		});
		expect(typeof response.messageId).toBe("string");
		await started.promise;
		await scenario.ctx.notify(methods.agent.session.cancel, { sessionId: scenario.sessionId });
		// The tool honours the abort signal, so no release is needed; release anyway as a backstop.
		gate.resolve();
		const result = await waitForIdle(scenario);
		expect(result.stopReason).toBe("cancelled");
		const toolCalls = toolCallById(scenario.updates);
		const card = [...toolCalls.values()][0];
		if (card === undefined) throw new Error("expected one tool card");
		expect(card.at(-1)?.status).toBe("cancelled");
	});

	it("f: cancel while a permission request is pending settles promptly", async () => {
		const askSeen = Promise.withResolvers<void>();
		let asked = false;
		const scenario = await startScenario({
			onPermission: () =>
				new Promise<RequestPermissionResponse>((resolve) => {
					asked = true;
					askSeen.resolve();
					// Never answer: cancel must settle the ask as deny.
					// Deliberate wall-clock fallback so a regression fails loudly
					// instead of hanging the suite forever.
					setTimeout(() => resolve(selected("allow_once")), 30000);
				}),
			setResponses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo never-runs" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		stops.push(scenario.stop);

		const response = await scenario.ctx.request(methods.agent.session.prompt, {
			sessionId: scenario.sessionId,
			prompt: [{ type: "text", text: "run it" }],
		});
		expect(typeof response.messageId).toBe("string");
		await askSeen.promise;
		expect(asked).toBe(true);
		const cancelStart = Date.now();
		await scenario.ctx.notify(methods.agent.session.cancel, { sessionId: scenario.sessionId });
		const result = await waitForIdle(scenario, 10000);
		expect(Date.now() - cancelStart).toBeLessThan(10000);
		expect(result.stopReason).toBe("cancelled");
		// The pending ask was denied by the cancel, not run: the card ends cancelled, never completed.
		const toolCalls = toolCallById(scenario.updates);
		const card = [...toolCalls.values()][0];
		if (card === undefined) throw new Error("expected one tool card");
		expect(card.at(-1)?.status).toBe("cancelled");
	});

	it("g: resume replay reproduces live entities", async () => {
		const replies = [
			fauxAssistantMessage(
				[
					fauxThinking("thinking about it"),
					{ type: "text", text: "live text here" },
					fauxToolCall("bash", { command: "echo live-bash" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "note.txt", edits: [{ oldText: "original", newText: "CHANGED" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		];
		const scripted = (_c: unknown, _o: unknown, state: { callCount: number }) =>
			replies[Math.min(state.callCount - 1, replies.length - 1)];
		const scenario = await startScenario({
			setResponses: [scripted, scripted, scripted, scripted],
		});
		stops.push(scenario.stop);
		const target = join(scenario.harness.tempDir, "note.txt");
		writeFileSync(target, "original\n");

		const result = await prompt(scenario, "do everything");
		expect(result.stopReason).toBe("end_turn");
		expect(scenario.permissionRequests).toHaveLength(2);

		const replayStart = scenario.updates.length;
		const live = scenario.updates.slice(0, replayStart);
		const liveText = filterUpdates(live, "agent_message_chunk")
			.map((update) => (update.content.type === "text" ? update.content.text : ""))
			.join("");
		const liveThought = filterUpdates(live, "agent_thought_chunk")
			.map((update) => (update.content.type === "text" ? update.content.text : ""))
			.join("");
		expect(liveText).toContain("live text here");
		expect(liveThought).toContain("thinking about it");

		await scenario.ctx.request(methods.agent.session.resume, {
			sessionId: scenario.sessionId,
			cwd: scenario.harness.tempDir,
			replayFrom: { type: "start" },
		});
		const replayed = scenario.updates.slice(replayStart);

		// Replayed agent text/thought are single full updates; live are chunks. Compare joined text instead.
		const replayedText = filterUpdates(replayed, "agent_message")
			.map((update) => JSON.stringify(update.content))
			.join("\n");
		const replayedThought = filterUpdates(replayed, "agent_thought")
			.map((update) => JSON.stringify(update.content))
			.join("\n");
		expect(replayedText).toContain("live text here");
		expect(replayedThought).toContain("thinking about it");

		// Both carry the bash and edit tools with the same final statuses and diff shape.
		const replayedTools = filterUpdates(replayed, "tool_call_update");
		expect(replayedTools.map((tool) => tool.status)).toEqual(["completed", "completed"]);
		const replayedEdit = replayedTools.find((tool) => tool.name === "edit" || tool.title === "Edit note.txt");
		const replayedDiff = replayedEdit?.content?.find((item) => item.type === "diff");
		if (replayedDiff?.type !== "diff") throw new Error("expected replayed edit diff");
		expect(replayedDiff.changes).toEqual([{ operation: "modify", path: target }]);
		const replayedPatch = (replayedDiff as unknown as { patch?: { format: string; text: string } }).patch;
		expect(replayedPatch?.format).toBe("git_patch");
		expect(replayedPatch?.text).toContain("diff --git");

		const liveUsers = filterUpdates(live, "user_message");
		expect(liveUsers).toHaveLength(1);
		const replayedUsers = filterUpdates(replayed, "user_message");
		expect(replayedUsers.map((update) => update.content)).toEqual(liveUsers.map((update) => update.content));
	});

	it("h: session/list includes the session; close and delete remove it", async () => {
		const scenario = await startScenario({
			setResponses: [fauxAssistantMessage("hi")],
		});
		stops.push(scenario.stop);
		await prompt(scenario, "hi");

		const listed = await scenario.ctx.request(methods.agent.session.list, {
			cwd: scenario.harness.tempDir,
		});
		expect(listed.sessions.map((session) => session.sessionId)).toContain(scenario.sessionId);

		await scenario.ctx.request(methods.agent.session.close, { sessionId: scenario.sessionId });
		await expect(
			scenario.ctx.request(methods.agent.session.prompt, {
				sessionId: scenario.sessionId,
				prompt: [{ type: "text", text: "after close" }],
			}),
		).rejects.toThrow();

		await scenario.ctx.request(methods.agent.session.delete, { sessionId: scenario.sessionId });
		const afterDelete = await scenario.ctx.request(methods.agent.session.list, {
			cwd: scenario.harness.tempDir,
		});
		expect(afterDelete.sessions.map((session) => session.sessionId)).not.toContain(scenario.sessionId);
	});

	it("i: set_config_option for thought_level emits config_option_update; invalid value errors", async () => {
		const scenario = await startScenario({
			harnessOptions: { models: [{ id: "faux-1", reasoning: true }] },
			setResponses: [fauxAssistantMessage("hi")],
		});
		stops.push(scenario.stop);

		const response = await scenario.ctx.request(methods.agent.session.setConfigOption, {
			sessionId: scenario.sessionId,
			configId: "thought_level",
			type: "id",
			value: "low",
		});
		const thought = response.configOptions.find((option) => option.configId === "thought_level");
		expect(thought?.type).toBe("select");
		if (thought?.type !== "select") throw new Error("expected select");
		expect(thought.currentValue).toBe("low");

		await prompt(scenario, "hi");
		const configUpdates = filterUpdates(scenario.updates, "config_option_update");
		expect(configUpdates.length).toBeGreaterThanOrEqual(1);
		const last = configUpdates[configUpdates.length - 1];
		const lastThought = last?.configOptions.find((option) => option.configId === "thought_level");
		expect(lastThought?.type).toBe("select");
		if (lastThought?.type !== "select") throw new Error("expected select");
		expect(lastThought.currentValue).toBe("low");

		await expect(
			scenario.ctx.request(methods.agent.session.setConfigOption, {
				sessionId: scenario.sessionId,
				configId: "thought_level",
				type: "id",
				value: "ultra",
			}),
		).rejects.toThrow();
	});
});
