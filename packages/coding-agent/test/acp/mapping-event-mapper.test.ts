import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { EventMapper } from "../../src/modes/acp/core/event-mapper.ts";
import { describeToolCall } from "../../src/modes/acp/core/tool-presentation.ts";
import type { CoreUpdate, ToolCallContent } from "../../src/modes/acp/core/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { chunkText, filterUpdates, isDiffContent } from "./updates.ts";

describe("acp mapping: EventMapper", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function wire(harness: Harness, diffContent?: (toolCallId: string) => ToolCallContent | undefined): CoreUpdate[] {
		const updates: CoreUpdate[] = [];
		let nextId = 0;
		const mapper = new EventMapper({
			cwd: harness.tempDir,
			sink: (update) => updates.push(update),
			describeToolCall,
			diffContent: diffContent ?? (() => undefined),
			newId: () => `id-${++nextId}`,
		});
		harness.session.subscribe((event) => mapper.handle(event));
		// Ungated session: no tool_call handlers, so the gate reports allow for every call.
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				mapper.onDecision({ toolCallId: event.toolCallId, allowed: true });
			}
		});
		return updates;
	}

	it("streams text deltas under one stable message id", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const updates = wire(harness);
		harness.setResponses([fauxAssistantMessage("hello world, this is a longer reply")]);

		await harness.session.prompt("go");

		const chunks = filterUpdates(updates, "agent_message_chunk");
		expect(chunks.length).toBeGreaterThan(1);
		const ids = new Set(chunks.map((chunk) => chunk.messageId));
		expect(ids.size).toBe(1);
		expect(chunks.map((chunk) => chunkText(chunk)).join("")).toBe("hello world, this is a longer reply");
	});

	it("streams thinking deltas as agent_thought_chunk with their own id", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const updates = wire(harness);
		harness.setResponses([
			fauxAssistantMessage([
				fauxThinking("let me think step by step about this"),
				{ type: "text", text: "final answer here" },
			]),
		]);

		await harness.session.prompt("go");

		const thoughts = filterUpdates(updates, "agent_thought_chunk");
		const texts = filterUpdates(updates, "agent_message_chunk");
		expect(thoughts.length).toBeGreaterThan(0);
		expect(texts.length).toBeGreaterThan(0);
		expect(thoughts.map((chunk) => chunkText(chunk)).join("")).toBe("let me think step by step about this");
		expect(texts.map((chunk) => chunkText(chunk)).join("")).toBe("final answer here");
		expect(new Set(thoughts.map((chunk) => chunk.messageId)).size).toBe(1);
		expect(thoughts[0]?.messageId).not.toBe(texts[0]?.messageId);
	});

	it("a tool turn: create, in_progress, completed with output", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => {
				const text =
					params !== null && typeof params === "object" && "text" in params && typeof params.text === "string"
						? params.text
						: "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [echo] });
		harnesses.push(harness);
		const updates = wire(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const toolUpdates = filterUpdates(updates, "tool_call_update");
		expect(toolUpdates.map((update) => update.status)).toEqual(["pending", "in_progress", "completed"]);
		const create = toolUpdates[0];
		expect(create?.name).toBe("echo");
		expect(create?.rawInput).toEqual({ text: "hi" });
		const end = toolUpdates[2];
		expect(end?.rawOutput).toBe("echo:hi");
		expect(end?.content).toEqual([{ type: "content", content: { type: "text", text: "echo:hi" } }]);
	});

	it("holds the first update until the gate decides", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => undefined);
				},
			],
		});
		harnesses.push(harness);
		const updates: CoreUpdate[] = [];
		let nextId = 0;
		const mapper = new EventMapper({
			cwd: harness.tempDir,
			sink: (update) => updates.push(update),
			describeToolCall,
			diffContent: () => undefined,
			newId: () => `id-${++nextId}`,
		});
		let held: { toolCallId: string } | undefined;
		harness.session.subscribe((event) => mapper.handle(event));
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				// tool_execution_start fires before the hook; no tool_call_update may exist yet.
				const toolCount = filterUpdates(updates, "tool_call_update").length;
				expect(toolCount).toBe(0);
				held = { toolCallId: event.toolCallId };
				mapper.onAsking(event.toolCallId);
				expect(filterUpdates(updates, "tool_call_update").length).toBe(0);
				mapper.onDecision({ toolCallId: event.toolCallId, allowed: true });
			}
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(held).toBeDefined();
		const toolUpdates = filterUpdates(updates, "tool_call_update");
		expect(toolUpdates.length).toBeGreaterThan(0);
		expect(toolUpdates[0]?.toolCallId).toBe(held?.toolCallId);
	});

	it("blocked call: released create, then failed with the reason", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => ({ block: true, reason: "no reads today" }));
				},
			],
		});
		harnesses.push(harness);
		const updates: CoreUpdate[] = [];
		let nextId = 0;
		const mapper = new EventMapper({
			cwd: harness.tempDir,
			sink: (update) => updates.push(update),
			describeToolCall,
			diffContent: () => undefined,
			newId: () => `id-${++nextId}`,
		});
		harness.session.subscribe((event) => mapper.handle(event));
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				mapper.onAsking(event.toolCallId);
				mapper.onDecision({ toolCallId: event.toolCallId, allowed: false, reason: "no reads today" });
			}
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const ends = harness.eventsOfType("tool_execution_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.isError).toBe(true);
		expect(ends[0]?.durationMs).toBeUndefined();
		const toolUpdates = filterUpdates(updates, "tool_call_update");
		expect(toolUpdates.map((update) => update.status)).toEqual(["pending", "failed"]);
		expect(toolUpdates[1]?.content).toEqual([{ type: "content", content: { type: "text", text: "no reads today" } }]);
	});

	it("nested calls surface as their own tool calls", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => {
				const text =
					params !== null && typeof params === "object" && "text" in params && typeof params.text === "string"
						? params.text
						: "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [echo],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "caller",
						label: "Caller",
						description: "Calls echo via ctx.executeTool",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _onUpdate, ctx) => {
							const outcome = await ctx.executeTool("echo", { text: "nested-hi" });
							const first = outcome.result.content[0];
							const nested = first !== undefined && first.type === "text" ? first.text : "?";
							return { content: [{ type: "text", text: `caller saw: ${nested}` }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const updates = wire(harness);
		harness.session.setActiveToolsByName(["caller", "echo"]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("caller", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const toolUpdates = filterUpdates(updates, "tool_call_update");
		const ids = [...new Set(toolUpdates.map((update) => update.toolCallId))];
		expect(ids).toHaveLength(2);
		const nestedId = ids.find((id) => id.includes("/"));
		expect(nestedId).toBeDefined();
		const nestedEnd = toolUpdates.find((update) => update.toolCallId === nestedId && update.status === "completed");
		expect(nestedEnd?.name ?? toolUpdates.find((u) => u.toolCallId === nestedId)?.name).toBe("echo");
	});

	it("bash streams to a terminal: command, cwd, output chunk, exit status", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const updates = wire(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo terminal-hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		const terminalUpdates = filterUpdates(updates, "terminal_update");
		const chunks = filterUpdates(updates, "terminal_output_chunk");
		expect(terminalUpdates.length).toBeGreaterThanOrEqual(2);
		const create = terminalUpdates[0];
		expect(create?.command).toBe("echo terminal-hi");
		expect(create?.cwd).toBe(harness.tempDir);
		const terminalId = create?.terminalId;
		expect(terminalId).toBeDefined();
		const decoded = chunks
			.filter((chunk) => chunk.terminalId === terminalId)
			.map((chunk) => Buffer.from(chunk.data, "base64").toString("utf-8"))
			.join("");
		expect(decoded).toContain("terminal-hi");
		const exit = terminalUpdates.find((update) => update.exitStatus !== undefined);
		expect(exit?.exitStatus).toEqual({ exitCode: 0 });
		const toolUpdates = filterUpdates(updates, "tool_call_update");
		expect(toolUpdates.at(-1)?.status).toBe("completed");
		expect(toolUpdates.at(-1)?.content).toEqual([{ type: "terminal", terminalId }]);
	});

	it("failing bash: failed status and non-zero exit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const updates = wire(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "exit 3" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		const toolUpdates = filterUpdates(updates, "tool_call_update");
		expect(toolUpdates.at(-1)?.status).toBe("failed");
		const terminalUpdates = filterUpdates(updates, "terminal_update");
		expect(terminalUpdates.find((update) => update.exitStatus !== undefined)?.exitStatus).toEqual({
			exitCode: 1,
		});
	});

	it("steer and followUp user messages arrive as user_message", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Waits for release",
			parameters: Type.Object({}),
			execute: async () => {
				await gate;
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [wait] });
		harnesses.push(harness);
		const updates = wire(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("first done"),
			fauxAssistantMessage("follow-up done"),
		]);

		const started = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await started;
		await harness.session.followUp("after current run");
		release();
		await promptPromise;

		const users = filterUpdates(updates, "user_message");
		expect(users).toHaveLength(2);
		expect(users[0]?.content).toEqual([{ type: "text", text: "start" }]);
		expect(users[1]?.content).toEqual([{ type: "text", text: "after current run" }]);
	});

	it("session_info_changed becomes session_info_update", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const updates = wire(harness);
		harness.setResponses([fauxAssistantMessage("hi")]);

		await harness.session.prompt("go");
		harness.session.setSessionName("my title");

		const infos = filterUpdates(updates, "session_info_update");
		expect(infos).toEqual([{ sessionUpdate: "session_info_update", title: "my title" }]);
	});

	it("edit end attaches diff content from diffContent()", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const target = join(harness.tempDir, "note.txt");
		writeFileSync(target, "original\n");
		const updates = wire(harness, (toolCallId) => ({
			type: "diff",
			changes: [{ operation: "modify", path: target }],
			patch: { format: "git_patch", text: `diff --git a/note.txt b/note.txt\n...${toolCallId}` },
		}));
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "note.txt", edits: [{ oldText: "original", newText: "CHANGED" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("edit it");

		const toolUpdates = filterUpdates(updates, "tool_call_update");
		const create = toolUpdates[0];
		expect(create?.title).toBe("Edit note.txt");
		expect(create?.kind).toBe("edit");
		const end = toolUpdates.at(-1);
		expect(end?.status).toBe("completed");
		const diff = end?.content?.find(isDiffContent);
		expect(diff?.type).toBe("diff");
	});
});
