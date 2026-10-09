import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { replaySession } from "../../src/modes/acp/core/replay.ts";
import { describeToolCall } from "../../src/modes/acp/core/tool-presentation.ts";
import type { CoreUpdate } from "../../src/modes/acp/core/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { filterUpdates, isDiffContent } from "./updates.ts";

describe("acp mapping: replaySession", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("replays a recorded session: user, agent, thought, tool, edit diff", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const target = join(harness.tempDir, "note.txt");
		writeFileSync(target, "original\n");
		harness.setResponses([
			fauxAssistantMessage([fauxThinking("thinking about the edit"), { type: "text", text: "editing now" }]),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "note.txt", edits: [{ oldText: "original", newText: "CHANGED" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("edit it");

		const updates: CoreUpdate[] = [];
		replaySession({
			entries: harness.sessionManager.getBranch(),
			sink: (update) => updates.push(update),
			cwd: harness.tempDir,
			describeToolCall,
		});

		const kinds = updates.map((update) => update.sessionUpdate);
		expect(kinds).toContain("user_message");
		expect(kinds).toContain("agent_message");
		expect(kinds).toContain("agent_thought");
		expect(kinds).toContain("tool_call_update");

		const users = filterUpdates(updates, "user_message");
		expect(users.map((update) => update.content)).toEqual([
			[{ type: "text", text: "first" }],
			[{ type: "text", text: "edit it" }],
		]);

		const thoughts = filterUpdates(updates, "agent_thought");
		expect(thoughts).toHaveLength(1);
		expect(thoughts[0]?.content).toEqual([{ type: "text", text: "thinking about the edit" }]);

		const tools = filterUpdates(updates, "tool_call_update");
		expect(tools).toHaveLength(1);
		expect(tools[0]?.status).toBe("completed");
		expect(tools[0]?.title).toBe("Edit note.txt");
		const diff = tools[0]?.content?.find(isDiffContent);
		expect(diff?.type).toBe("diff");
		if (diff?.type === "diff") {
			expect(diff.changes).toEqual([{ operation: "modify", path: target }]);
			expect(diff.patch?.format).toBe("git_patch");
			expect(diff.patch?.text.startsWith("diff --git")).toBe(true);
		}
	});

	it("message ids are deterministic per entry", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("go");

		const first: CoreUpdate[] = [];
		const second: CoreUpdate[] = [];
		const branch = harness.sessionManager.getBranch();
		replaySession({ entries: branch, sink: (update) => first.push(update), cwd: harness.tempDir, describeToolCall });
		replaySession({
			entries: branch,
			sink: (update) => second.push(update),
			cwd: harness.tempDir,
			describeToolCall,
		});
		expect(second).toEqual(first);
		const ids = [
			...filterUpdates(first, "user_message").map((update) => update.messageId),
			...filterUpdates(first, "agent_message").map((update) => update.messageId),
		];
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("failed tools replay as failed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		const updates: CoreUpdate[] = [];
		replaySession({
			entries: harness.sessionManager.getBranch(),
			sink: (update) => updates.push(update),
			cwd: harness.tempDir,
			describeToolCall,
		});
		const tools = filterUpdates(updates, "tool_call_update");
		expect(tools).toHaveLength(1);
		expect(tools[0]?.status).toBe("failed");
	});
});
