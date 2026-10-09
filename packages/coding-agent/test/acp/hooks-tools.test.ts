/**
 * Tool-ops tests: capturing-tool parity with the built-ins, pi.registerTool
 * override, mutation recording, and the v2 diff patch format.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Diff, ToolCallContent } from "@agentclientprotocol/sdk/experimental/v2";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { FileMutation } from "../../src/modes/acp/core/types.ts";
import { createMutationCapturingTools, mutationsToDiffContent } from "../../src/modes/acp/pi/tool-ops.ts";
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";

function asDiff(content: ToolCallContent | undefined): Diff {
	if (content === undefined || content.type !== "diff") throw new Error("expected diff content");
	const diff = content as unknown as { type: "diff" } & Diff;
	expect(diff.type).toBe("diff");
	return diff;
}

function toolText(harness: Harness, toolName: string): { isError: boolean; text: string } {
	const result = getToolResult(harness, toolName);
	const first = result.content[0];
	return {
		isError: result.isError,
		text: first !== undefined && first.type === "text" ? first.text : JSON.stringify(result.content),
	};
}

function recordAll(mutations: FileMutation[]): () => (mutation: FileMutation) => void {
	return () => (mutation: FileMutation) => {
		mutations.push(mutation);
	};
}

describe("mutation capturing tools", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("registers through pi.registerTool and overrides the built-ins", async () => {
		const mutations: FileMutation[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					for (const tool of createMutationCapturingTools(process.cwd(), recordAll(mutations))) {
						pi.registerTool(tool);
					}
				},
			],
		});
		harnesses.push(harness);
		// The registry must resolve edit/write to the capturing definitions...
		expect(harness.session.getToolDefinition("edit")?.name).toBe("edit");
		expect(harness.session.getToolDefinition("write")?.name).toBe("write");
		// ...and getAllTools reports them as extension tools, not built-ins.
		const sources = new Map(harness.session.getAllTools().map((t) => [t.name, t.sourceInfo.source]));
		expect(sources.get("edit")).not.toBe("builtin");
		expect(sources.get("write")).not.toBe("builtin");
	});

	it("edit parity with builtin + records pre/post keyed by toolCallId", async () => {
		const target = "poem.txt";
		const runWith = async (useCapture: boolean): Promise<{ text: string; isError: boolean }> => {
			const mutations: FileMutation[] = [];
			const harness = await createHarness({
				extensionFactories:
					useCapture === false
						? []
						: [
								(pi) => {
									for (const tool of createMutationCapturingTools(process.cwd(), recordAll(mutations))) {
										pi.registerTool(tool);
									}
								},
							],
			});
			harnesses.push(harness);
			writeFileSync(join(harness.tempDir, target), "roses are red\nviolets are blue\n");
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("edit", { path: target, edits: [{ oldText: "red", newText: "RED" }] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("edit it");
			const outcome = toolText(harness, "edit");
			if (useCapture) {
				expect(mutations).toHaveLength(1);
				expect(mutations[0]?.oldText).toBe("roses are red\nviolets are blue\n");
				expect(mutations[0]?.newText).toBe("roses are RED\nviolets are blue\n");
				expect(mutations[0]?.path).toBe(join(harness.tempDir, target));
				const starts = harness.eventsOfType("tool_execution_start");
				expect(starts).toHaveLength(1);
				expect(mutations[0]?.toolCallId).toBe(starts[0]?.toolCallId);
			}
			return outcome;
		};
		const builtin = await runWith(false);
		const capturing = await runWith(true);
		expect(builtin).toEqual(capturing);
		expect(capturing.isError).toBe(false);
	});

	it("write parity with builtin + records null oldText for new files", async () => {
		const runWith = async (useCapture: boolean): Promise<{ text: string; isError: boolean }> => {
			const mutations: FileMutation[] = [];
			const harness = await createHarness({
				extensionFactories:
					useCapture === false
						? []
						: [
								(pi) => {
									for (const tool of createMutationCapturingTools(process.cwd(), recordAll(mutations))) {
										pi.registerTool(tool);
									}
								},
							],
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: "sub/out.txt", content: "hello\n" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("write it");
			const outcome = toolText(harness, "write");
			expect(readFileSync(join(harness.tempDir, "sub", "out.txt"), "utf-8")).toBe("hello\n");
			if (useCapture) {
				expect(mutations).toHaveLength(1);
				expect(mutations[0]?.oldText).toBeNull();
				expect(mutations[0]?.newText).toBe("hello\n");
			}
			return outcome;
		};
		const builtin = await runWith(false);
		const capturing = await runWith(true);
		expect(builtin).toEqual(capturing);
		expect(capturing.isError).toBe(false);
	});

	it("records no mutation when the tool errors", async () => {
		const mutations: FileMutation[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					for (const tool of createMutationCapturingTools(process.cwd(), recordAll(mutations))) {
						pi.registerTool(tool);
					}
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("edit it");
		expect(toolText(harness, "edit").isError).toBe(true);
		expect(mutations).toHaveLength(0);
	});

	it("one shared registration routes mutations to each call's session", async () => {
		const first: FileMutation[] = [];
		const second: FileMutation[] = [];
		const bySessionId: Record<string, FileMutation[] | undefined> = {};
		const shared = createMutationCapturingTools(process.cwd(), (ctx) => {
			const mutations = bySessionId[ctx.sessionManager.getSessionId()];
			return mutations === undefined ? undefined : recordAll(mutations)();
		});
		const registerShared = {
			factory: (pi: ExtensionAPI) => {
				for (const tool of shared) {
					pi.registerTool(tool);
				}
			},
		};
		const firstHarness = await createHarness({ extensionFactories: [registerShared] });
		harnesses.push(firstHarness);
		const secondHarness = await createHarness({ extensionFactories: [registerShared] });
		harnesses.push(secondHarness);
		bySessionId[firstHarness.session.sessionId] = first;
		bySessionId[secondHarness.session.sessionId] = second;
		for (const harness of [firstHarness, secondHarness]) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: "out.txt", content: "hello\n" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("write it");
		}
		expect(first).toHaveLength(1);
		expect(first[0]?.path).toBe(join(firstHarness.tempDir, "out.txt"));
		expect(second).toHaveLength(1);
		expect(second[0]?.path).toBe(join(secondHarness.tempDir, "out.txt"));
	});
});

describe("mutationsToDiffContent", () => {
	it("returns undefined for no mutations", () => {
		expect(mutationsToDiffContent([])).toBeUndefined();
	});

	it("builds changes + a git-style patch for a modify", () => {
		const diff = asDiff(
			mutationsToDiffContent([
				{
					toolCallId: "call-1",
					path: "/repo/poem.txt",
					oldText: "roses are red\nviolets are blue\n",
					newText: "roses are RED\nviolets are blue\n",
				},
			]),
		);
		expect(diff.changes).toEqual([{ operation: "modify", path: "/repo/poem.txt", fileType: "text" }]);
		expect(diff.patch?.format).toBe("git_patch");
		const patch = diff.patch?.text ?? "";
		expect(patch).toContain("diff --git a/repo/poem.txt b/repo/poem.txt");
		expect(patch).toContain("--- a/repo/poem.txt");
		expect(patch).toContain("+++ b/repo/poem.txt");
		expect(patch).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
		expect(patch).toContain("-roses are red");
		expect(patch).toContain("+roses are RED");
	});

	it("marks created files as add with /dev/null source", () => {
		const diff = asDiff(
			mutationsToDiffContent([{ toolCallId: "call-2", path: "/repo/new.txt", oldText: null, newText: "hello\n" }]),
		);
		expect(diff.changes).toEqual([{ operation: "add", path: "/repo/new.txt", fileType: "text" }]);
		const patch = diff.patch?.text ?? "";
		expect(patch).toContain("diff --git a/repo/new.txt b/repo/new.txt");
		expect(patch).toContain("--- /dev/null");
		expect(patch).toContain("+++ b/repo/new.txt");
		expect(patch).toContain("+hello");
	});

	it("concatenates one block per file for multi-file calls", () => {
		const diff = asDiff(
			mutationsToDiffContent([
				{ toolCallId: "call-3", path: "/repo/a.txt", oldText: "a\n", newText: "A\n" },
				{ toolCallId: "call-3", path: "/repo/b.txt", oldText: null, newText: "B\n" },
			]),
		);
		expect(diff.changes.map((c) => ("operation" in c ? c.operation : "?"))).toEqual(["modify", "add"]);
		const patch = diff.patch?.text ?? "";
		expect(patch).toContain("diff --git a/repo/a.txt b/repo/a.txt");
		expect(patch).toContain("diff --git a/repo/b.txt b/repo/b.txt");
	});
});
