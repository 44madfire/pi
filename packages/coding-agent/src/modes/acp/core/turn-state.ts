import type { StopReason, Usage } from "@agentclientprotocol/sdk/experimental/v2";
import type { StopReason as PiStopReason } from "@earendil-works/pi-ai";
import type { CoreUpdate, UpdateSink } from "./types.ts";

/** Assistant stop info TurnState needs; `aborted` on the event says whether the run was cancelled. */
export interface StopReasonInput {
	aborted: boolean;
	lastAssistant?: { stopReason: PiStopReason; errorMessage?: string } | undefined;
}

/**
 * Map pi's end-of-turn signals to an ACP stop reason (PLAN table).
 *
 * `aborted` is authoritative: when abort lands on a tool boundary the last
 * assistant message may read `error`, but the turn was cancelled.
 * Provider refusals arrive as `error` with explanatory text, so `refusal` is
 * detected by message match only.
 */
export function stopReasonFor(input: StopReasonInput): StopReason {
	if (input.aborted) return "cancelled";
	const last = input.lastAssistant;
	if (last === undefined) return "end_turn";
	if (last.stopReason === "error") {
		if (last.errorMessage !== undefined && /refus/i.test(last.errorMessage)) return "refusal";
		return "error";
	}
	if (last.stopReason === "length") return "max_tokens";
	return "end_turn";
}

export interface IdleInput {
	stopReason: StopReason;
	usage?: Usage | undefined;
}

/**
 * One ACP turn's foreground state. Session-host drives it directly:
 * `running()` at prompt start, `requiresAction()`/`resumed()` around gate and
 * UI asks, `idle()` at `agent_settled`. One ACP turn equals one `prompt()`;
 * retry, compaction, steer, and followUp all extend the same run.
 */
export class TurnState {
	private readonly sink: UpdateSink;

	constructor(sink: UpdateSink) {
		this.sink = sink;
	}

	running(): void {
		this.sink({ sessionUpdate: "state_update", state: "running" });
	}

	requiresAction(): void {
		this.sink({ sessionUpdate: "state_update", state: "requires_action" });
	}

	resumed(): void {
		this.sink({ sessionUpdate: "state_update", state: "running" });
	}

	idle(input: IdleInput): void {
		const update: CoreUpdate = {
			sessionUpdate: "state_update",
			state: "idle",
			stopReason: input.stopReason,
			...(input.usage === undefined ? {} : { usage: input.usage }),
		};
		this.sink(update);
	}
}
