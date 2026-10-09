import { isAbsolute, relative, resolve } from "node:path";
import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk/experimental/v2";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { BashExecutionMessage } from "../../../core/messages.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import type { DescribeToolCall, UpdateSink } from "./types.ts";

export interface ReplayOptions {
	entries: readonly SessionEntry[];
	sink: UpdateSink;
	cwd: string;
	describeToolCall: DescribeToolCall;
	diffContentForReplay?: (message: ToolResultMessage) => ToolCallContent | undefined;
}

function textBlocksOf(content: (TextContent | ImageContent)[]): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text });
		} else {
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
		}
	}
	return blocks;
}

function userContentOf(message: UserMessage): ContentBlock[] {
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return textBlocksOf(message.content);
}

function assistantTextOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function assistantThinkingOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<typeof block, { type: "thinking" }> => block.type === "thinking")
		.map((block) => (block.redacted ? "" : block.thinking))
		.join("");
}

function toolTextOf(message: ToolResultMessage): string {
	return message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Stored edit `details.patch` has `---`/`+++` headers but no `diff --git` line; add it. */
function gitPatchOf(patch: string, path: string): string {
	if (patch.startsWith("diff --git")) return patch;
	return `diff --git a/${path} b/${path}\n${patch}`;
}

function storedPatchOf(message: ToolResultMessage): string | undefined {
	const details = message.details;
	if (typeof details !== "object" || details === null) return undefined;
	if (!("patch" in details) || typeof details.patch !== "string" || details.patch.length === 0) return undefined;
	return details.patch;
}

function shellCommandOf(message: ToolResultMessage): string | undefined {
	const details = message.details;
	if (typeof details !== "object" || details === null) return undefined;
	if (!("command" in details) || typeof details.command !== "string") return undefined;
	return details.command;
}

/**
 * Replay a bash/powershell result the way the live turn emitted it: a
 * terminal entity carrying the output plus a tool card referencing it.
 * The transcript keeps no per-tool arguments, so the command comes from the
 * tool details when the built-in recorded it.
 */
function replayShellResult(message: ToolResultMessage, options: ReplayOptions): void {
	const terminalId = `replay-${message.toolCallId}`;
	const text = toolTextOf(message);
	const command = shellCommandOf(message) ?? "";
	options.sink({
		sessionUpdate: "terminal_update",
		terminalId,
		command,
		cwd: options.cwd,
		output: { data: Buffer.from(text, "utf-8").toString("base64") },
		exitStatus: { exitCode: message.isError ? 1 : 0 },
	});
	const presentation = options.describeToolCall(message.toolName, command === "" ? {} : { command }, options.cwd);
	options.sink({
		sessionUpdate: "tool_call_update",
		toolCallId: message.toolCallId,
		name: message.toolName,
		title: presentation.title,
		kind: presentation.kind,
		status: message.isError ? "failed" : "completed",
		...(text.length > 0 ? { rawOutput: text } : {}),
		content: [{ type: "terminal", terminalId }],
	});
}

function replayUserMessage(entryId: string, message: UserMessage, options: ReplayOptions): void {
	options.sink({
		sessionUpdate: "user_message",
		messageId: `replay-${entryId}`,
		content: userContentOf(message),
	});
}

function replayAssistantMessage(entryId: string, message: AssistantMessage, options: ReplayOptions): void {
	const text = assistantTextOf(message);
	if (text.length > 0) {
		options.sink({
			sessionUpdate: "agent_message",
			messageId: `replay-${entryId}`,
			content: [{ type: "text", text }],
		});
	}
	const thinking = assistantThinkingOf(message);
	if (thinking.length > 0) {
		options.sink({
			sessionUpdate: "agent_thought",
			messageId: `replay-${entryId}-thought`,
			content: [{ type: "text", text: thinking }],
		});
	}
}

function replayToolResult(message: ToolResultMessage, options: ReplayOptions): void {
	if (message.toolName === "bash" || message.toolName === "powershell") {
		replayShellResult(message, options);
		return;
	}
	const text = toolTextOf(message);
	const content: ToolCallContent[] = [];
	if (text.length > 0) content.push({ type: "content", content: { type: "text", text } });
	const supplied = options.diffContentForReplay?.(message);
	// The transcript keeps no per-tool arguments, so resolve the path from the tool text:
	// edit details carry the patch; its --- header names the file the model passed.
	let replayPath: string | undefined;
	if (message.toolName === "edit") {
		const patch = storedPatchOf(message);
		const headerPath = patch?.match(/^--- (.+)$/m)?.[1];
		if (headerPath !== undefined && patch !== undefined) {
			const absolute = isAbsolute(headerPath) ? headerPath : resolve(options.cwd, headerPath);
			// Titles show the path the model passed; the patch header sometimes
			// carries an absolute path, so relativize back to the session cwd.
			const display = relative(options.cwd, absolute);
			replayPath = display !== "" && !display.startsWith("..") ? display : headerPath;
			if (supplied === undefined) {
				content.push({
					type: "diff",
					changes: [{ operation: "modify", path: absolute }],
					patch: { format: "git_patch", text: gitPatchOf(patch, headerPath) },
				});
			}
		}
	}
	const presentation = options.describeToolCall(
		message.toolName,
		replayPath === undefined ? {} : { path: replayPath },
		options.cwd,
	);
	options.sink({
		sessionUpdate: "tool_call_update",
		toolCallId: message.toolCallId,
		name: message.toolName,
		title: presentation.title,
		kind: presentation.kind,
		status: message.isError ? "failed" : "completed",
		...(content.length > 0 ? { content } : {}),
		...(presentation.locations.length > 0 ? { locations: presentation.locations } : {}),
	});
}

function replayBashExecution(entryId: string, message: BashExecutionMessage, options: ReplayOptions): void {
	const terminalId = `replay-${entryId}`;
	options.sink({
		sessionUpdate: "terminal_update",
		terminalId,
		command: message.command,
		cwd: options.cwd,
		output: { data: Buffer.from(message.output, "utf-8").toString("base64") },
		exitStatus: { exitCode: message.cancelled ? null : (message.exitCode ?? null) },
	});
	options.sink({
		sessionUpdate: "tool_call_update",
		toolCallId: `replay-${entryId}`,
		name: "bash",
		title: `$ ${message.command.split("\n", 1)[0] ?? message.command}`,
		kind: "execute",
		status: message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0) ? "failed" : "completed",
		content: [{ type: "terminal", terminalId }],
	});
}

/**
 * Replay a session's entries as v2 updates for `resume { replayFrom: start }`.
 *
 * Walks the given entries in order (pass the active branch, root-first) and
 * emits `user_message`, `agent_message`, `agent_thought`, and completed
 * `tool_call_update`s. Message ids are deterministic per entry
 * (`replay-<entryId>`), so a resumed client sees the same entities. Edit
 * results carry a diff built from the stored patch; `diffContentForReplay`
 * can supply richer diffs when the caller kept the file text.
 */
export function replaySession(options: ReplayOptions): void {
	for (const entry of options.entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		switch (message.role) {
			case "user":
				replayUserMessage(entry.id, message, options);
				break;
			case "assistant":
				replayAssistantMessage(entry.id, message, options);
				break;
			case "toolResult":
				replayToolResult(message, options);
				break;
			case "bashExecution":
				replayBashExecution(entry.id, message, options);
				break;
			default:
				break;
		}
	}
}
