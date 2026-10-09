/**
 * Shared contract for the ACP mode.
 *
 * The core speaks ACP v2 shapes (type-only imports from the pinned SDK). Wire adapters own all
 * runtime SDK usage; `wire/v1` (P2) re-encodes these v2 shapes for v1 clients.
 */
import type {
	CreateElicitationRequest,
	CreateElicitationResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionUpdate,
	StopReason,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@agentclientprotocol/sdk/experimental/v2";

/** One `session/update` payload for a single session, in v2 shape. */
export type CoreUpdate = SessionUpdate;

/** Receives core updates for one session, in emission order. */
export type UpdateSink = (update: CoreUpdate) => void;

/** Requests the core sends to the client for one session. The wire adapter fills in `sessionId`. */
export interface ClientPort {
	requestPermission(
		request: Omit<RequestPermissionRequest, "sessionId">,
		signal: AbortSignal,
	): Promise<RequestPermissionResponse>;
	/** Present only when the client advertised form elicitation. */
	createElicitation?: (request: CreateElicitationRequest, signal: AbortSignal) => Promise<CreateElicitationResponse>;
}

/** Presentation of a tool call, shared by the event mapper and the permission gate. */
export interface ToolCallPresentation {
	title: string;
	kind: ToolKind;
	locations: ToolCallLocation[];
}

/** Maps a pi tool call to its ACP presentation. `cwd` resolves relative paths to absolute ones. */
export type DescribeToolCall = (toolName: string, input: unknown, cwd: string) => ToolCallPresentation;

/** Outcome of the permission gate for one tool call. Reported for every gated or ungated call. */
export interface GateDecision {
	toolCallId: string;
	allowed: boolean;
	/** Present when blocked: the reason the model sees. */
	reason?: string;
}

/** Notified by the permission gate. The event mapper holds a call's first update until its decision. */
export interface GateObserver {
	/** A permission request for this call is about to be sent (v2: `state_update: requires_action`). */
	onAsking(toolCallId: string): void;
	onDecision(decision: GateDecision): void;
}

/** File content before and after one edit/write tool call. `oldText` is null when the file did not exist. */
export interface FileMutation {
	toolCallId: string;
	/** Absolute path. */
	path: string;
	oldText: string | null;
	newText: string;
}

/** Turns the mutations recorded for one tool call into ACP diff content. */
export type MutationsToDiffContent = (mutations: readonly FileMutation[]) => ToolCallContent | undefined;

export type { StopReason, ToolCallContent, ToolCallLocation, ToolKind };
