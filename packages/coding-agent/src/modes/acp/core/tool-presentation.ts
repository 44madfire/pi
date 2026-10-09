import { isAbsolute, resolve } from "node:path";
import type { ToolCallLocation } from "@agentclientprotocol/sdk/experimental/v2";
import type { DescribeToolCall, ToolCallPresentation } from "./types.ts";

/** One field of a tool-call argument object; unknown until the caller validates it. */
function field(input: unknown, name: string): unknown {
	if (typeof input !== "object" || input === null) return undefined;
	if (!(name in input)) return undefined;
	// Dynamic key read after an `in` check proves the key exists; the value stays unknown.
	const record = input as Record<string, unknown>;
	return record[name];
}

function stringField(input: unknown, name: string): string | undefined {
	const value = field(input, name);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(input: unknown, name: string): number | undefined {
	const value = field(input, name);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveLocation(path: string, cwd: string, line?: number): ToolCallLocation {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	return line === undefined ? { path: absolute } : { path: absolute, line };
}

function readPresentation(input: unknown, cwd: string): ToolCallPresentation {
	const path = stringField(input, "path") ?? stringField(input, "file_path");
	const offset = numberField(input, "offset");
	const limit = numberField(input, "limit");
	const range =
		offset !== undefined || limit !== undefined
			? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
			: "";
	const title = path !== undefined ? `Read ${path}${range}` : "Read file";
	return {
		title,
		kind: "read",
		locations: path !== undefined ? [resolveLocation(path, cwd, offset)] : [],
	};
}

function grepPresentation(input: unknown, cwd: string): ToolCallPresentation {
	const pattern = stringField(input, "pattern");
	const path = stringField(input, "path");
	const title = pattern !== undefined ? `Search for "${pattern}"${path ? ` in ${path}` : ""}` : "Search files";
	return {
		title,
		kind: "search",
		locations: path !== undefined ? [resolveLocation(path, cwd)] : [],
	};
}

function findPresentation(input: unknown, cwd: string): ToolCallPresentation {
	const pattern = stringField(input, "pattern");
	const path = stringField(input, "path");
	const title = pattern !== undefined ? `Find ${pattern}${path ? ` in ${path}` : ""}` : "Find files";
	return {
		title,
		kind: "search",
		locations: path !== undefined ? [resolveLocation(path, cwd)] : [],
	};
}

function lsPresentation(input: unknown, cwd: string): ToolCallPresentation {
	const path = stringField(input, "path");
	const title = path !== undefined ? `List ${path}` : "List directory";
	return {
		title,
		kind: "read",
		locations: [resolveLocation(path ?? ".", cwd)],
	};
}

function editPresentation(input: unknown, cwd: string): ToolCallPresentation {
	const path = stringField(input, "path") ?? stringField(input, "file_path");
	const title = path !== undefined ? `Edit ${path}` : "Edit file";
	return {
		title,
		kind: "edit",
		locations: path !== undefined ? [resolveLocation(path, cwd)] : [],
	};
}

function writePresentation(input: unknown, cwd: string): ToolCallPresentation {
	const path = stringField(input, "path") ?? stringField(input, "file_path");
	const title = path !== undefined ? `Write ${path}` : "Write file";
	return {
		title,
		kind: "edit",
		locations: path !== undefined ? [resolveLocation(path, cwd)] : [],
	};
}

function shellPresentation(toolName: string, input: unknown): ToolCallPresentation {
	const command = stringField(input, "command");
	const firstLine = command?.split("\n", 1)[0]?.trim();
	const title =
		firstLine !== undefined && firstLine.length > 0
			? `$ ${firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine}`
			: `Run ${toolName}`;
	return { title, kind: "execute", locations: [] };
}

function unknownPresentation(toolName: string, input: unknown, cwd: string): ToolCallPresentation {
	const path = stringField(input, "path") ?? stringField(input, "file_path");
	return {
		title: toolName,
		kind: "other",
		locations: path !== undefined ? [resolveLocation(path, cwd)] : [],
	};
}

/**
 * Title, kind, and locations for a pi tool call.
 *
 * Titles mirror what the TUI renderers show (`Read path:lines`, `$ command`).
 * Locations resolve relative paths against `cwd`; `read` carries the offset
 * line when the model supplied one.
 */
export const describeToolCall: DescribeToolCall = (toolName, input, cwd) => {
	switch (toolName) {
		case "read":
			return readPresentation(input, cwd);
		case "grep":
			return grepPresentation(input, cwd);
		case "find":
			return findPresentation(input, cwd);
		case "ls":
			return lsPresentation(input, cwd);
		case "edit":
			return editPresentation(input, cwd);
		case "write":
			return writePresentation(input, cwd);
		case "bash":
		case "powershell":
			return shellPresentation(toolName, input);
		default:
			return unknownPresentation(toolName, input, cwd);
	}
};
