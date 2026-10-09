import type {
	AvailableCommand,
	SessionConfigOption,
	StopReason,
	UsageUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StopReason as AgentStopReason, ImageContent } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import type {
	ExtensionContext,
	ExtensionUIContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../../core/extensions/types.ts";
import { applyConfigOption, buildConfigOptions, buildUsageUpdate, watchConfigOptions } from "../pi/catalogs.ts";
import { buildAvailableCommands } from "../pi/commands.ts";
import { PermissionGate } from "../pi/permission-gate.ts";
import { registerAcpSessionBinding, unregisterAcpSessionBinding } from "../pi/session-extension.ts";
import { mutationsToDiffContent } from "../pi/tool-ops.ts";
import { createUiBridge } from "../pi/ui-bridge.ts";
import { EventMapper } from "./event-mapper.ts";
import { replaySession } from "./replay.ts";
import { describeToolCall } from "./tool-presentation.ts";
import { stopReasonFor, TurnState } from "./turn-state.ts";
import type {
	ClientPort,
	CoreUpdate,
	FileMutation,
	GateDecision,
	GateObserver,
	MutationsToDiffContent,
	UpdateSink,
} from "./types.ts";

/**
 * Owns one live ACP session: its pi AgentSession, event mapping, turn state,
 * permission gate, and UI bridge.
 *
 * ACP session id === pi session id (`runtime.session.sessionId`).
 */
export class AcpSessionHost implements GateObserver {
	private readonly runtime: AgentSessionRuntime;
	private readonly gate: PermissionGate;
	private readonly turnState: TurnState;
	private readonly mapper: EventMapper;
	private readonly mutationsByToolCall = new Map<string, FileMutation[]>();
	private readonly sink: UpdateSink;
	private readonly uiContext: ExtensionUIContext;
	private readonly unsubscribe: () => void;
	private readonly stopConfigWatch: () => void;
	private turnActive = false;

	constructor(runtime: AgentSessionRuntime, client: ClientPort, sink: UpdateSink, options: { approveAll: boolean }) {
		this.runtime = runtime;
		this.sink = sink;
		const diffContent: MutationsToDiffContent = (mutations) => mutationsToDiffContent(mutations);
		this.gate = new PermissionGate({ describeToolCall, approveAll: options.approveAll });
		this.turnState = new TurnState(sink);
		this.mapper = new EventMapper({
			cwd: runtime.cwd,
			sink,
			describeToolCall,
			diffContent: (toolCallId) => {
				const mutations = this.mutationsByToolCall.get(toolCallId);
				return mutations === undefined ? undefined : diffContent(mutations);
			},
			newId: () => crypto.randomUUID(),
		});
		this.uiContext = createUiBridge(client, {
			onAsking: () => this.turnState.requiresAction(),
			onAnswered: () => this.turnState.resumed(),
		});
		registerAcpSessionBinding({
			sessionId: runtime.session.sessionId,
			recordMutation: (mutation) => {
				const list = this.mutationsByToolCall.get(mutation.toolCallId);
				if (list === undefined) {
					this.mutationsByToolCall.set(mutation.toolCallId, [mutation]);
				} else {
					list.push(mutation);
				}
			},
			handleToolCall: (event, ctx) =>
				this.gate.handle(
					event,
					{ client, observer: this, cwd: ctx.cwd, tools: runtime.session.getAllTools() },
					ctx.signal,
				),
		});
		this.unsubscribe = runtime.session.subscribe((event) => this.onSessionEvent(event));
		this.stopConfigWatch = watchConfigOptions(runtime.session, sink);
	}

	get sessionId(): string {
		return this.runtime.session.sessionId;
	}

	get piSession(): AgentSession {
		return this.runtime.session;
	}

	get isTurnActive(): boolean {
		return this.turnActive;
	}

	/** Bind extensions for RPC-style dialogs. Called once before the first prompt. */
	async bind(): Promise<void> {
		await this.runtime.session.bindExtensions({ mode: "rpc", uiContext: this.uiContext });
	}

	initialConfigOptions(): SessionConfigOption[] {
		return buildConfigOptions(this.runtime.session);
	}

	initialCommands(): AvailableCommand[] {
		return buildAvailableCommands(this.runtime.session);
	}

	async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
		return applyConfigOption(this.runtime.session, configId, value);
	}

	/**
	 * Send every retained update for this session to the sink, in order, before
	 * the caller responds to `session/resume`.
	 */
	replay(): void {
		replaySession({
			entries: this.runtime.session.sessionManager.getBranch(),
			sink: this.sink,
			cwd: this.runtime.cwd,
			describeToolCall,
		});
	}

	/**
	 * Run one ACP turn. Resolves when the turn settles (`agent_settled`); the
	 * wire layer runs this detached so the `{messageId}` response is queued first.
	 */
	async runTurn(text: string, images: ImageContent[] | undefined): Promise<void> {
		this.turnActive = true;
		this.mapper.beginTurn();
		this.turnState.running();
		try {
			await this.runtime.session.prompt(text, {
				images,
				source: "rpc",
				streamingBehavior: "followUp",
			});
		} finally {
			this.turnActive = false;
		}
	}

	async cancel(): Promise<void> {
		this.mapper.markCancelling();
		this.gate.cancelPending();
		await this.runtime.session.abort();
	}

	async close(): Promise<void> {
		this.stopConfigWatch();
		this.unsubscribe();
		unregisterAcpSessionBinding(this.sessionId);
		await this.gate.cancelPending();
		await this.runtime.session.abort();
		await this.runtime.dispose();
	}

	onAsking(toolCallId: string): void {
		this.mapper.onAsking(toolCallId);
		this.turnState.requiresAction();
	}

	onDecision(decision: GateDecision): void {
		this.mapper.onDecision(decision);
		this.turnState.resumed();
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_settled") {
			const lastAssistant = findLastAssistant(this.runtime.session.messages);
			const stopReason: StopReason = stopReasonFor({
				aborted: event.aborted,
				lastAssistant,
			});
			if (stopReason === "error") {
				this.emitErrorMessage(lastAssistant?.errorMessage);
			}
			const usage = buildUsageUpdate(this.runtime.session);
			if (usage !== undefined) {
				this.emitUsage(usage);
			}
			this.turnState.idle({ stopReason });
			return;
		}
		this.mapper.handle(event);
	}

	private emitErrorMessage(detail: string | undefined): void {
		const update: CoreUpdate = {
			sessionUpdate: "agent_message",
			messageId: `err-${this.sessionId}-${Date.now()}`,
			content: [{ type: "text", text: detail ?? "The agent run failed." }],
		};
		this.sink(update);
	}

	private emitUsage(usage: Omit<UsageUpdate, "sessionUpdate">): void {
		this.sink({ sessionUpdate: "usage_update", ...usage });
	}
}

function findLastAssistant(
	messages: readonly AgentMessage[],
): { stopReason: AgentStopReason; errorMessage?: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	return undefined;
}

export type { ToolCallEvent, ToolCallEventResult, ExtensionContext };
