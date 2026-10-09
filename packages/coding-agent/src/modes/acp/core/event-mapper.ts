import type { ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent, UserMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import type {
	CoreUpdate,
	DescribeToolCall,
	GateDecision,
	GateObserver,
	ToolCallPresentation,
	UpdateSink,
} from "./types.ts";

export interface EventMapperOptions {
	cwd: string;
	sink: UpdateSink;
	describeToolCall: DescribeToolCall;
	diffContent: (toolCallId: string) => ToolCallContent | undefined;
	newId: () => string;
}

interface ToolCallState {
	toolCallId: string;
	toolName: string;
	args: unknown;
	parentToolCallId: string | undefined;
	presentation: ToolCallPresentation;
	/** True once the first update was emitted (the call exists on the client). */
	created: boolean;
	/** Set when the gate asked about this call before its decision arrived. */
	asked: boolean;
	decision: GateDecision | undefined;
	terminalId: string | undefined;
	outputText: string;
	ended: boolean;
}

/** Tools whose output streams to an agent-owned terminal instead of text content. */
function isShellTool(toolName: string): boolean {
	return toolName === "bash" || toolName === "powershell";
}

function resultTextOf(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	if (!("content" in result) || !Array.isArray(result.content)) return "";
	const parts: string[] = [];
	for (const block of result.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("\n");
}

function base64Of(text: string): string {
	return Buffer.from(text, "utf-8").toString("base64");
}

function commandOf(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	if (!("command" in args) || typeof args.command !== "string") return "";
	return args.command;
}

function userMessageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Maps `AgentSessionEvent`s to v2 `SessionUpdate`s.
 *
 * Message text and thinking deltas stream as `agent_message_chunk` /
 * `agent_thought_chunk` keyed by a stable message id per assistant message.
 * User messages inserted mid-run (steer, followUp) arrive as full
 * `user_message` upserts. Tool calls become `tool_call_update`s; the first
 * update is held until the gate reports its decision, because
 * `tool_execution_start` fires before the `tool_call` hook runs. Bash and
 * powershell calls additionally own a terminal: `terminal_update` carries
 * the command and cwd, `terminal_output_chunk` carries base64 output bytes,
 * and the tool call references it with a `{type:"terminal"}` content item.
 */
export class EventMapper implements GateObserver {
	private readonly cwd: string;
	private readonly sink: UpdateSink;
	private readonly describeToolCall: DescribeToolCall;
	private readonly diffContent: (toolCallId: string) => ToolCallContent | undefined;
	private readonly newId: () => string;
	private readonly calls = new Map<string, ToolCallState>();
	private assistantMessageId: string | undefined;
	private thoughtMessageId: string | undefined;
	private skipNextUserMessage = false;
	private cancelling = false;

	constructor(options: EventMapperOptions) {
		this.cwd = options.cwd;
		this.sink = options.sink;
		this.describeToolCall = options.describeToolCall;
		this.diffContent = options.diffContent;
		this.newId = options.newId;
	}

	handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				this.onMessageStart(event.message);
				return;
			case "message_update":
				this.onMessageUpdate(event.assistantMessageEvent);
				return;
			case "tool_execution_start":
				this.onToolStart(event.toolCallId, event.toolName, event.args, event.parentToolCallId);
				return;
			case "tool_execution_update":
				this.onToolUpdate(event.toolCallId, event.partialResult);
				return;
			case "tool_execution_end":
				this.onToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
				return;
			case "session_info_changed":
				this.sink({ sessionUpdate: "session_info_update", title: event.name ?? null });
				return;
			default:
				return;
		}
	}

	onAsking(toolCallId: string): void {
		const call = this.calls.get(toolCallId);
		if (call !== undefined) call.asked = true;
	}

	onDecision(decision: GateDecision): void {
		const call = this.calls.get(decision.toolCallId);
		if (call === undefined) return;
		call.decision = decision;
		this.release(call);
	}

	/**
	 * Start of an ACP prompt turn. The wire already sent the prompt as the `user_message` carrying the
	 * response's `messageId`, so pi's own `message_start` for that prompt is not echoed again.
	 */
	beginTurn(): void {
		this.skipNextUserMessage = true;
		this.cancelling = false;
	}

	/** `session/cancel` arrived: calls that end with an error or a denial from now on end `cancelled`. */
	markCancelling(): void {
		this.cancelling = true;
	}

	private endStatus(call: ToolCallState, isError: boolean): ToolCallStatus {
		const denied = call.decision !== undefined && !call.decision.allowed;
		if (!denied && !isError) return "completed";
		return this.cancelling ? "cancelled" : "failed";
	}

	private onMessageStart(message: AgentMessage): void {
		if (message.role === "assistant") {
			this.assistantMessageId = this.newId();
			this.thoughtMessageId = undefined;
			return;
		}
		if (message.role === "user") {
			if (this.skipNextUserMessage) {
				this.skipNextUserMessage = false;
				return;
			}
			this.sink({
				sessionUpdate: "user_message",
				messageId: this.newId(),
				content: [{ type: "text", text: userMessageText(message) }],
			});
		}
	}

	private onMessageUpdate(assistantEvent: AssistantMessageEvent): void {
		switch (assistantEvent.type) {
			case "text_delta": {
				if (this.assistantMessageId === undefined) this.assistantMessageId = this.newId();
				this.sink({
					sessionUpdate: "agent_message_chunk",
					messageId: this.assistantMessageId,
					content: { type: "text", text: assistantEvent.delta },
				});
				return;
			}
			case "thinking_delta": {
				if (this.thoughtMessageId === undefined) this.thoughtMessageId = this.newId();
				this.sink({
					sessionUpdate: "agent_thought_chunk",
					messageId: this.thoughtMessageId,
					content: { type: "text", text: assistantEvent.delta },
				});
				return;
			}
			default:
				return;
		}
	}

	private onToolStart(
		toolCallId: string,
		toolName: string,
		args: unknown,
		parentToolCallId: string | undefined,
	): void {
		const call: ToolCallState = {
			toolCallId,
			toolName,
			args,
			parentToolCallId,
			presentation: this.describeToolCall(toolName, args, this.cwd),
			created: false,
			asked: false,
			decision: undefined,
			terminalId: undefined,
			outputText: "",
			ended: false,
		};
		this.calls.set(toolCallId, call);
		// tool_execution_start fires before the tool_call hook, so the call stays
		// invisible until the gate reports its decision via onDecision.
	}

	private onToolUpdate(toolCallId: string, partialResult: unknown): void {
		const call = this.calls.get(toolCallId);
		if (call === undefined || call.ended) return;
		if (!call.created) return;
		if (!isShellTool(call.toolName)) return;
		const text = resultTextOf(partialResult);
		if (text.length <= call.outputText.length) return;
		const delta = text.slice(call.outputText.length);
		call.outputText = text;
		if (call.terminalId === undefined) return;
		this.sink({
			sessionUpdate: "terminal_output_chunk",
			terminalId: call.terminalId,
			data: base64Of(delta),
		});
	}

	private onToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
		const call = this.calls.get(toolCallId);
		if (call === undefined) return;
		call.ended = true;
		// The gate always reports a decision before the end event: blocked calls
		// surface as tool_execution_end with isError and no durationMs. If the
		// gate never ran (ungated session), create the call now.
		this.release(call);
		if (!call.created) return;
		const blocked = call.decision !== undefined && !call.decision.allowed;
		const status = this.endStatus(call, isError);
		const resultText = resultTextOf(result);
		const text = blocked && call.decision?.reason ? call.decision.reason : resultText;
		if (isShellTool(toolName)) {
			this.finishShellCall(call, text, isError);
			return;
		}
		const content: ToolCallContent[] = text.length > 0 ? [{ type: "content", content: { type: "text", text } }] : [];
		const diff = this.diffContent(toolCallId);
		if (diff !== undefined) content.push(diff);
		const update: CoreUpdate = {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status,
			rawOutput: resultText,
			...(content.length > 0 ? { content } : {}),
		};
		this.sink(update);
	}

	/** Emit the call's first update once its gate decision is known. */
	private release(call: ToolCallState): void {
		if (call.created) return;
		if (call.decision === undefined && !call.ended) return;
		call.created = true;
		const denied = call.decision !== undefined && !call.decision.allowed;
		const status: ToolCallStatus = call.ended && denied ? this.endStatus(call, false) : "pending";
		this.sink({
			sessionUpdate: "tool_call_update",
			toolCallId: call.toolCallId,
			name: call.toolName,
			title: call.presentation.title,
			kind: call.presentation.kind,
			status,
			rawInput: call.args,
			...(call.presentation.locations.length > 0 ? { locations: call.presentation.locations } : {}),
		});
		if (denied) return;
		if (isShellTool(call.toolName) && call.terminalId === undefined) {
			call.terminalId = this.newId();
			this.sink({
				sessionUpdate: "terminal_update",
				terminalId: call.terminalId,
				command: commandOf(call.args),
				cwd: this.cwd,
			});
			this.sink({
				sessionUpdate: "tool_call_update",
				toolCallId: call.toolCallId,
				status: "in_progress",
				content: [{ type: "terminal", terminalId: call.terminalId }],
			});
		} else if (!call.ended) {
			this.sink({
				sessionUpdate: "tool_call_update",
				toolCallId: call.toolCallId,
				status: "in_progress",
			});
		}
	}

	private finishShellCall(call: ToolCallState, text: string, isError: boolean): void {
		if (call.terminalId !== undefined) {
			if (text.length > call.outputText.length) {
				const delta = text.slice(call.outputText.length);
				call.outputText = text;
				this.sink({
					sessionUpdate: "terminal_output_chunk",
					terminalId: call.terminalId,
					data: base64Of(delta),
				});
			}
			this.sink({
				sessionUpdate: "terminal_update",
				terminalId: call.terminalId,
				exitStatus: { exitCode: isError ? 1 : 0 },
			});
		}
		const status = this.endStatus(call, isError);
		const content: ToolCallContent[] =
			call.terminalId !== undefined ? [{ type: "terminal", terminalId: call.terminalId }] : [];
		if (call.terminalId === undefined && text.length > 0) {
			content.push({ type: "content", content: { type: "text", text } });
		}
		this.sink({
			sessionUpdate: "tool_call_update",
			toolCallId: call.toolCallId,
			status,
			rawOutput: text,
			...(content.length > 0 ? { content } : {}),
		});
	}
}
