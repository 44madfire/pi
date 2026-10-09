import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { client, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createAcpSessionExtension } from "../../src/modes/acp/pi/session-extension.ts";
import { createV2Runtime } from "../../src/modes/acp/wire/v2.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

/**
 * Minimal in-process ACP v2 smoke: a v2 SDK ClientApp drives initialize, new,
 * and a one-turn prompt with the faux provider — messageId, then running,
 * chunks, idle end_turn.
 */
describe("acp v2 smoke", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs initialize, new, and a one-turn prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [createAcpSessionExtension()],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello from pi")]);

		const cwd = harness.tempDir;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			throw new Error("smoke test creates no extra runtimes");
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
		const v2 = createV2Runtime(initialRuntime, createRuntime, { approveAll: true });

		const updates: SessionUpdate[] = [];
		const clientApp = client({ name: "smoke-client" }).onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params.update);
		});

		await clientApp.connectWith(v2.app, async (agent) => {
			const init = await agent.request(methods.agent.initialize, {
				protocolVersion: 2,
				info: { name: "smoke", version: "0.0.0" },
				capabilities: {},
			});
			expect(init.protocolVersion).toBe(2);
			expect(init.capabilities?.session).toBeDefined();

			const created = await agent.buildSession(cwd).start();
			const sessionId = created.sessionId;
			expect(typeof sessionId).toBe("string");

			const response = await created.prompt("hi");
			expect(typeof response.messageId).toBe("string");

			const states: string[] = [];
			for (;;) {
				const message = await created.nextUpdate();
				if (message.kind === "stop") {
					expect(message.stopReason).toBe("end_turn");
					break;
				}
				const update = message.update;
				if (update.sessionUpdate === "state_update" && update.state === "running") {
					states.push("running");
				}
			}
			expect(states).toContain("running");
			created.dispose();
		});

		await v2.disposeAll();

		const kinds = updates.map((update) => update.sessionUpdate);
		expect(kinds).toContain("user_message");
		expect(kinds).toContain("state_update");
		expect(kinds.some((kind) => kind === "agent_message_chunk" || kind === "agent_message")).toBe(true);
		const idles = updates.filter((update) => update.sessionUpdate === "state_update" && update.state === "idle");
		expect(idles.length).toBeGreaterThan(0);
	});
});
