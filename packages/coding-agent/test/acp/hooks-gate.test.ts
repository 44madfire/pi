/**
 * Permission gate tests: policy rows, always-cache, cancel, nesting, observer order.
 */

import type { RequestPermissionResponse } from "@agentclientprotocol/sdk/experimental/v2";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallEvent, ToolCallEventResult, ToolInfo } from "../../src/core/extensions/types.ts";
import { describeToolCall } from "../../src/modes/acp/core/tool-presentation.ts";
import type { ClientPort, GateDecision } from "../../src/modes/acp/core/types.ts";
import { PermissionGate } from "../../src/modes/acp/pi/permission-gate.ts";
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";

function selected(optionId: string): RequestPermissionResponse {
	return { outcome: { outcome: "selected", optionId } };
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

interface ScriptedClient {
	client: ClientPort;
	requests: Array<{ title: string; description?: string | null; options: string[] }>;
	answer: (response: RequestPermissionResponse | ((index: number) => RequestPermissionResponse)) => void;
	nextAsk: () => Promise<void>;
}

function scriptedClient(): ScriptedClient {
	const requests: ScriptedClient["requests"] = [];
	const responders: Array<(response: RequestPermissionResponse) => void> = [];
	const askResolvers: Array<() => void> = [];
	let pendingAsks = 0;
	const client: ClientPort = {
		requestPermission: async (request, signal) => {
			requests.push({
				title: request.title,
				description: request.description,
				options: request.options.map((o) => o.optionId),
			});
			pendingAsks++;
			for (const resolve of askResolvers.splice(0)) resolve();
			return new Promise<RequestPermissionResponse>((resolve, reject) => {
				if (signal.aborted) {
					reject(new Error("aborted"));
					return;
				}
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				responders.push(resolve);
			});
		},
	};
	return {
		client,
		requests,
		answer: (response) => {
			const r = typeof response === "function" ? response(requests.length - 1) : response;
			const responder = responders.shift();
			if (responder === undefined) throw new Error("no open ask to answer");
			responder(r);
		},
		nextAsk: () => {
			if (pendingAsks > 0) {
				pendingAsks--;
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				askResolvers.push(() => {
					pendingAsks--;
					resolve();
				});
			});
		},
	};
}

function recordingObserver() {
	const events: Array<{ type: "asking" | "decision"; toolCallId: string; allowed?: boolean }> = [];
	return {
		events,
		observer: {
			onAsking: (toolCallId: string) => events.push({ type: "asking", toolCallId }),
			onDecision: (decision: GateDecision) =>
				events.push({ type: "decision", toolCallId: decision.toolCallId, allowed: decision.allowed }),
		},
	};
}

function toolEvent(toolName: string, input: Record<string, unknown>, toolCallId = "call-1"): ToolCallEvent {
	return { type: "tool_call", toolCallId, toolName, input } as ToolCallEvent;
}

describe("permission gate policy", () => {
	it("allows read/grep/find/ls without asking", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const { client, requests } = scriptedClient();
		const { events, observer } = recordingObserver();
		for (const toolName of ["read", "grep", "find", "ls"]) {
			const result = await gate.handle(toolEvent(toolName, { path: "x" }, `call-${toolName}`), {
				client,
				observer,
				cwd: "/tmp",
			});
			expect(result).toBeUndefined();
		}
		expect(requests).toHaveLength(0);
		expect(events.filter((e) => e.type === "decision" && e.allowed)).toHaveLength(4);
		expect(events.some((e) => e.type === "asking")).toBe(false);
	});

	it("asks for edit/write/bash/powershell", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const scripted = scriptedClient();
		const { events, observer } = recordingObserver();
		const session = { client: scripted.client, observer, cwd: "/tmp" };
		const cases = [
			toolEvent("edit", { path: "a.txt", edits: [] }, "call-edit"),
			toolEvent("write", { path: "b.txt", content: "x" }, "call-write"),
			toolEvent("bash", { command: "ls" }, "call-bash"),
			toolEvent("powershell", { command: "Get-ChildItem" }, "call-ps"),
		];
		for (const event of cases) {
			const pending = gate.handle(event, session);
			await scripted.nextAsk();
			scripted.answer(selected("allow_once"));
			expect(await pending).toBeUndefined();
		}
		expect(scripted.requests).toHaveLength(4);
		for (const request of scripted.requests) {
			expect(request.options).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
		}
		expect(events.filter((e) => e.type === "asking")).toHaveLength(4);
		expect(events.filter((e) => e.type === "decision" && e.allowed)).toHaveLength(4);
	});

	it("asks with a tool_call subject carrying presentation and rawInput", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		let seen: unknown;
		const client: ClientPort = {
			requestPermission: async (request) => {
				seen = request.subject;
				return selected("reject_once");
			},
		};
		const { observer } = recordingObserver();
		const event = toolEvent("bash", { command: "rm -rf /tmp/x" }, "call-subject");
		const result = (await gate.handle(event, { client, observer, cwd: "/repo" })) as ToolCallEventResult;
		expect(result.block).toBe(true);
		expect(seen).toMatchObject({
			type: "tool_call",
			toolCall: {
				toolCallId: "call-subject",
				name: "bash",
				rawInput: { command: "rm -rf /tmp/x" },
			},
		});
	});

	it("allows unknown read-only tools, asks for others", async () => {
		const tools = [
			{ name: "docs", annotations: { readOnlyHint: true } },
			{ name: "docs_destructive", annotations: { readOnlyHint: true, destructiveHint: true } },
			{ name: "writer", annotations: { readOnlyHint: false } },
			{ name: "plain" },
		] as ToolInfo[];
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const scripted = scriptedClient();
		const { observer } = recordingObserver();
		const session = { client: scripted.client, observer, cwd: "/tmp", tools };

		expect(await gate.handle(toolEvent("docs", {}, "c-docs"), session)).toBeUndefined();
		expect(scripted.requests).toHaveLength(0);

		for (const [name, id] of [
			["docs_destructive", "c-d"],
			["writer", "c-w"],
			["plain", "c-p"],
			["missing", "c-m"],
		]) {
			const pending = gate.handle(toolEvent(name, {}, id), session);
			await scripted.nextAsk();
			scripted.answer(selected("allow_once"));
			expect(await pending).toBeUndefined();
		}
		expect(scripted.requests).toHaveLength(4);
	});

	it("treats cancelled, unknown, and failed outcomes as deny", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const { events, observer } = recordingObserver();
		const answers: RequestPermissionResponse[] = [
			CANCELLED,
			{ outcome: { outcome: "_future" } } as unknown as RequestPermissionResponse,
			selected("bogus_option"),
		];
		let index = 0;
		const client: ClientPort = {
			requestPermission: async () => {
				const answer = answers[index++];
				if (answer === undefined) throw new Error("client exploded");
				return answer;
			},
		};
		const session = { client, observer, cwd: "/tmp" };
		for (let i = 0; i < 4; i++) {
			const result = (await gate.handle(toolEvent("edit", { path: "a" }, `c-${i}`), session)) as ToolCallEventResult;
			expect(result.block).toBe(true);
			expect(result.reason).toBeTruthy();
		}
		expect(events.filter((e) => e.type === "decision" && !e.allowed)).toHaveLength(4);
	});

	it("approveAll bypasses the gate without asking", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: true });
		const { client, requests } = scriptedClient();
		const { events, observer } = recordingObserver();
		const result = await gate.handle(toolEvent("bash", { command: "rm -rf x" }, "c-1"), {
			client,
			observer,
			cwd: "/tmp",
		});
		expect(result).toBeUndefined();
		expect(requests).toHaveLength(0);
		expect(events).toEqual([{ type: "decision", toolCallId: "c-1", allowed: true }]);
	});
});

describe("permission gate always-cache", () => {
	it("allow_always suppresses later asks for the tool", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const scripted = scriptedClient();
		const { events, observer } = recordingObserver();
		const session = { client: scripted.client, observer, cwd: "/tmp" };

		const first = gate.handle(toolEvent("edit", { path: "a" }, "c-1"), session);
		await scripted.nextAsk();
		scripted.answer(selected("allow_always"));
		expect(await first).toBeUndefined();

		expect(await gate.handle(toolEvent("edit", { path: "b" }, "c-2"), session)).toBeUndefined();
		expect(scripted.requests).toHaveLength(1);
		expect(events.filter((e) => e.type === "asking")).toHaveLength(1);
		expect(events.filter((e) => e.type === "decision" && e.allowed)).toHaveLength(2);
	});

	it("reject_always denies later calls without asking", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const scripted = scriptedClient();
		const { observer } = recordingObserver();
		const session = { client: scripted.client, observer, cwd: "/tmp" };

		const first = gate.handle(toolEvent("bash", { command: "git status" }, "c-1"), session);
		await scripted.nextAsk();
		scripted.answer(selected("reject_always"));
		expect(((await first) as ToolCallEventResult).block).toBe(true);

		const second = (await gate.handle(
			toolEvent("bash", { command: "git diff" }, "c-2"),
			session,
		)) as ToolCallEventResult;
		expect(second.block).toBe(true);
		expect(scripted.requests).toHaveLength(1);
	});

	it("keys bash/powershell by first command word", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const scripted = scriptedClient();
		const { observer } = recordingObserver();
		const session = { client: scripted.client, observer, cwd: "/tmp" };

		const first = gate.handle(toolEvent("bash", { command: "git status" }, "c-1"), session);
		await scripted.nextAsk();
		scripted.answer(selected("allow_always"));
		expect(await first).toBeUndefined();

		// Same executable, different args: cached.
		expect(await gate.handle(toolEvent("bash", { command: "git diff --stat" }, "c-2"), session)).toBeUndefined();
		// Different executable: asks again.
		const third = gate.handle(toolEvent("bash", { command: "npm test" }, "c-3"), session);
		await scripted.nextAsk();
		scripted.answer(selected("allow_once"));
		expect(await third).toBeUndefined();
		// Powershell is keyed separately from bash.
		const fourth = gate.handle(toolEvent("powershell", { command: "git status" }, "c-4"), session);
		await scripted.nextAsk();
		scripted.answer(selected("allow_once"));
		expect(await fourth).toBeUndefined();

		expect(scripted.requests).toHaveLength(3);
	});

	it("cache is per gate instance", async () => {
		const scripted = scriptedClient();
		const { observer } = recordingObserver();
		const session = { client: scripted.client, observer, cwd: "/tmp" };
		const gateA = new PermissionGate({ describeToolCall, approveAll: false });

		const first = gateA.handle(toolEvent("edit", { path: "a" }, "c-1"), session);
		await scripted.nextAsk();
		scripted.answer(selected("allow_always"));
		await first;

		const gateB = new PermissionGate({ describeToolCall, approveAll: false });
		const second = gateB.handle(toolEvent("edit", { path: "a" }, "c-2"), session);
		await scripted.nextAsk();
		scripted.answer(selected("allow_once"));
		await second;
		expect(scripted.requests).toHaveLength(2);
	});
});

describe("permission gate cancellation and ordering", () => {
	it("cancelPending denies the open ask; decisions report for every call", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const scripted = scriptedClient();
		const { events, observer } = recordingObserver();
		const pending = gate.handle(toolEvent("bash", { command: "sleep 60" }, "c-1"), {
			client: scripted.client,
			observer,
			cwd: "/tmp",
		});
		await scripted.nextAsk();
		gate.cancelPending();
		const result = (await pending) as ToolCallEventResult;
		expect(result.block).toBe(true);
		expect(events).toEqual([
			{ type: "asking", toolCallId: "c-1" },
			{ type: "decision", toolCallId: "c-1", allowed: false },
		]);
	});

	it("an aborted run signal denies the ask", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const scripted = scriptedClient();
		const { observer } = recordingObserver();
		const controller = new AbortController();
		const pending = gate.handle(
			toolEvent("edit", { path: "a" }, "c-1"),
			{ client: scripted.client, observer, cwd: "/tmp" },
			controller.signal,
		);
		await scripted.nextAsk();
		controller.abort();
		expect(((await pending) as ToolCallEventResult).block).toBe(true);
	});

	it("reports onAsking before the request and onDecision once on every path", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const order: string[] = [];
		const client: ClientPort = {
			requestPermission: async () => {
				order.push("request");
				return selected("allow_once");
			},
		};
		const observer = {
			onAsking: (id: string) => order.push(`asking:${id}`),
			onDecision: (d: GateDecision) => order.push(`decision:${d.toolCallId}:${d.allowed}`),
		};
		await gate.handle(toolEvent("write", { path: "a", content: "x" }, "c-1"), {
			client,
			observer,
			cwd: "/tmp",
		});
		expect(order).toEqual(["asking:c-1", "request", "decision:c-1:true"]);
	});
});

describe("permission gate in session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("gates nested ctx.executeTool calls the same way", async () => {
		const gate = new PermissionGate({ describeToolCall, approveAll: false });
		const scripted = scriptedClient();
		const { events, observer } = recordingObserver();
		const seen: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "caller",
						label: "Caller",
						description: "Calls bash via ctx.executeTool",
						parameters: { type: "object", properties: {} } as never,
						execute: async (_id, _args, _signal, _onUpdate, ctx) => {
							const outcome = await ctx.executeTool("bash", { command: "echo nested-hi" });
							const first = outcome.result.content[0];
							const text = first !== undefined && first.type === "text" ? first.text : "?";
							return { content: [{ type: "text", text: `caller saw: ${text}` }], details: {} };
						},
					});
					pi.on("tool_call", (event) => {
						seen.push(`${event.toolName}:${event.toolCallId}:${event.parentToolCallId ?? "-"}`);
						return gate.handle(event, {
							client: scripted.client,
							observer,
							cwd: harness.tempDir,
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["caller", "bash"]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("caller", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("go");
		await scripted.nextAsk();
		scripted.answer(selected("allow_once"));
		await scripted.nextAsk();
		scripted.answer(selected("allow_once"));
		await promptPromise;

		expect(seen.some((line) => line.startsWith("bash:") && !line.endsWith(":-"))).toBe(true);
		expect(scripted.requests).toHaveLength(2);
		const result = getToolResult(harness, "caller");
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("nested-hi");
		expect(events.filter((e) => e.type === "decision")).toHaveLength(2);
	});
});
