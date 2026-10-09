import { describe, expect, it } from "vitest";
import { describeToolCall } from "../../src/modes/acp/core/tool-presentation.ts";

describe("acp mapping: describeToolCall", () => {
	const cwd = process.platform === "win32" ? "C:\\repo" : "/repo";

	it("read: title with path and line range, kind read, absolute location with line", () => {
		const presentation = describeToolCall("read", { path: "src/a.ts", offset: 10, limit: 5 }, cwd);
		expect(presentation.title).toBe("Read src/a.ts:10-14");
		expect(presentation.kind).toBe("read");
		expect(presentation.locations).toHaveLength(1);
		expect(presentation.locations[0]?.line).toBe(10);
		expect(presentation.locations[0]?.path.endsWith("a.ts")).toBe(true);
	});

	it("read without offset: no range, no line", () => {
		const presentation = describeToolCall("read", { path: "src/a.ts" }, cwd);
		expect(presentation.title).toBe("Read src/a.ts");
		expect(presentation.locations[0]?.line).toBeUndefined();
	});

	it("grep: pattern title, kind search", () => {
		const presentation = describeToolCall("grep", { pattern: "foo.*", path: "src" }, cwd);
		expect(presentation.title).toBe('Search for "foo.*" in src');
		expect(presentation.kind).toBe("search");
		expect(presentation.locations).toHaveLength(1);
	});

	it("find: pattern title, kind search", () => {
		const presentation = describeToolCall("find", { pattern: "**/*.ts" }, cwd);
		expect(presentation.title).toBe("Find **/*.ts");
		expect(presentation.kind).toBe("search");
		expect(presentation.locations).toHaveLength(0);
	});

	it("ls: defaults to cwd", () => {
		const presentation = describeToolCall("ls", {}, cwd);
		expect(presentation.title).toBe("List directory");
		expect(presentation.kind).toBe("read");
		expect(presentation.locations).toHaveLength(1);
		expect(presentation.locations[0]?.path).toBe(cwd);
	});

	it("edit and write: kind edit with file location", () => {
		const edit = describeToolCall("edit", { path: "note.txt", edits: [] }, cwd);
		expect(edit.title).toBe("Edit note.txt");
		expect(edit.kind).toBe("edit");
		expect(edit.locations).toHaveLength(1);
		const write = describeToolCall("write", { path: "new.txt", content: "x" }, cwd);
		expect(write.title).toBe("Write new.txt");
		expect(write.kind).toBe("edit");
		expect(write.locations).toHaveLength(1);
	});

	it("bash: first command line as title, kind execute, no locations", () => {
		const presentation = describeToolCall("bash", { command: "git status --short\nsecond line" }, cwd);
		expect(presentation.title).toBe("$ git status --short");
		expect(presentation.kind).toBe("execute");
		expect(presentation.locations).toHaveLength(0);
	});

	it("powershell: same shape as bash", () => {
		const presentation = describeToolCall("powershell", { command: "Get-ChildItem" }, cwd);
		expect(presentation.title).toBe("$ Get-ChildItem");
		expect(presentation.kind).toBe("execute");
	});

	it("unknown tools: tool name as title, kind other", () => {
		const presentation = describeToolCall("some-extension-tool", { path: "x.md" }, cwd);
		expect(presentation.title).toBe("some-extension-tool");
		expect(presentation.kind).toBe("other");
		expect(presentation.locations).toHaveLength(1);
	});
});
