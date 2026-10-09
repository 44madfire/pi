/**
 * ACP mode protocol tests: an SDK ClientApp drives `createAcpApp` in-process
 * over a direct connection, asserting on the `session/update` stream.
 */

import type { ClientContext, SessionUpdate, StopReason } from "@agentclientprotocol/sdk/experimental/v2";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAcpApp } from "../src/modes/acp/acp-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

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
}): Promise<Scenario> {
	const harness = await createHarness({ tools: options.tools });
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
	const { app, disposeAll } = createAcpApp(initialRuntime, createRuntime, {});
	const updates: SessionUpdate[] = [];
	const clientApp = client({ name: "acp-mode-test" }).onNotification(methods.client.session.update, ({ params }) => {
		updates.push(params.update);
	});
	const connection = clientApp.connect(app);
	const ctx = connection.agent;
	const initializeResponse = await ctx.request(methods.agent.initialize, {
		protocolVersion: PROTOCOL_VERSION,
		info: { name: "test", version: "0.0.0" },
	});
	const created = await ctx.request(methods.agent.session.new, { cwd: harness.tempDir });
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

	it("lists, resumes, rejects replay, and closes sessions", async () => {
		const scenario = await startScenario({ responses: [fauxAssistantMessage("hi")] });
		stops.push(scenario.stop);

		const listed = await scenario.ctx.request(methods.agent.session.list, { cwd: scenario.harness.tempDir });
		expect(listed.sessions.map((session) => session.sessionId)).toContain(scenario.sessionId);

		const resumed = await scenario.ctx.request(methods.agent.session.resume, {
			sessionId: scenario.sessionId,
			cwd: scenario.harness.tempDir,
		});
		expect(resumed).toEqual({});

		await expect(
			scenario.ctx.request(methods.agent.session.resume, {
				sessionId: scenario.sessionId,
				cwd: scenario.harness.tempDir,
				replayFrom: { type: "start" },
			}),
		).rejects.toThrow();

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
});
