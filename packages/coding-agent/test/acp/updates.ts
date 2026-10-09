import type {
	AgentMessage,
	AgentThought,
	ContentChunk,
	TerminalOutputChunk,
	TerminalUpdate,
	ToolCallContent,
	ToolCallUpdate,
	UserMessage,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { CoreUpdate } from "../../src/modes/acp/core/types.ts";

export type AgentMessageChunkUpdate = ContentChunk & { sessionUpdate: "agent_message_chunk" };
export type AgentThoughtChunkUpdate = ContentChunk & { sessionUpdate: "agent_thought_chunk" };
export type UserMessageUpdate = UserMessage & { sessionUpdate: "user_message" };
export type AgentMessageUpdate = AgentMessage & { sessionUpdate: "agent_message" };
export type AgentThoughtUpdate = AgentThought & { sessionUpdate: "agent_thought" };
export type ToolCallUpdateUpdate = ToolCallUpdate & { sessionUpdate: "tool_call_update" };
export type TerminalUpdateUpdate = TerminalUpdate & { sessionUpdate: "terminal_update" };
export type TerminalOutputChunkUpdate = TerminalOutputChunk & { sessionUpdate: "terminal_output_chunk" };

/**
 * `Array.filter` does not narrow the SDK's `SessionUpdate` union on
 * `sessionUpdate` alone (the fallback variant widens the tag to `string`),
 * so tests filter through these guards instead.
 */
export function isUpdate<Tag extends string>(
	update: CoreUpdate,
	tag: Tag,
): update is Extract<CoreUpdate, { sessionUpdate: Tag }> {
	return (update.sessionUpdate as string) === tag;
}

export function filterUpdates<Tag extends string>(
	updates: readonly CoreUpdate[],
	tag: Tag,
): Extract<CoreUpdate, { sessionUpdate: Tag }>[] {
	return updates.filter((update): update is Extract<CoreUpdate, { sessionUpdate: Tag }> => isUpdate(update, tag));
}

export function chunkText(update: AgentMessageChunkUpdate | AgentThoughtChunkUpdate): string {
	const content = update.content;
	return content.type === "text" && typeof content.text === "string" ? content.text : "";
}

export type DiffContent = Extract<ToolCallContent, { type: "diff" }>;

/** Narrow `ToolCallContent` on `type`; plain `.find` keeps the union widened. */
export function isDiffContent(content: ToolCallContent): content is DiffContent {
	return content.type === "diff";
}
