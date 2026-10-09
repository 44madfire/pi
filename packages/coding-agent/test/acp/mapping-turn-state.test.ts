import type { StopReason } from "@agentclientprotocol/sdk/experimental/v2";
import { describe, expect, it } from "vitest";
import { stopReasonFor, TurnState } from "../../src/modes/acp/core/turn-state.ts";
import type { CoreUpdate } from "../../src/modes/acp/core/types.ts";

describe("acp mapping: stopReasonFor", () => {
	it("settled without abort and stop assistant: end_turn", () => {
		expect(stopReasonFor({ aborted: false, lastAssistant: { stopReason: "stop" } })).toBe("end_turn");
	});

	it("aborted flag wins even when the last assistant reads error", () => {
		expect(stopReasonFor({ aborted: true, lastAssistant: { stopReason: "error", errorMessage: "boom" } })).toBe(
			"cancelled",
		);
	});

	it("length without retry: max_tokens", () => {
		expect(stopReasonFor({ aborted: false, lastAssistant: { stopReason: "length" } })).toBe("max_tokens");
	});

	it("plain error: error", () => {
		expect(
			stopReasonFor({ aborted: false, lastAssistant: { stopReason: "error", errorMessage: "overloaded" } }),
		).toBe("error");
	});

	it("refusal-shaped error: refusal", () => {
		expect(
			stopReasonFor({
				aborted: false,
				lastAssistant: { stopReason: "error", errorMessage: "The model refused to complete the request" },
			}),
		).toBe("refusal");
	});

	it("no assistant message: end_turn", () => {
		expect(stopReasonFor({ aborted: false, lastAssistant: undefined })).toBe("end_turn");
	});

	it("toolUse at settle (should not happen): end_turn", () => {
		expect(stopReasonFor({ aborted: false, lastAssistant: { stopReason: "toolUse" } })).toBe("end_turn");
	});
});

describe("acp mapping: TurnState", () => {
	function collect(): { updates: CoreUpdate[]; state: TurnState } {
		const updates: CoreUpdate[] = [];
		return { updates, state: new TurnState((update) => updates.push(update)) };
	}

	it("running -> requires_action -> resumed -> idle(end_turn)", () => {
		const { updates, state } = collect();
		state.running();
		state.requiresAction();
		state.resumed();
		const stopReason: StopReason = "end_turn";
		state.idle({ stopReason });
		expect(updates).toEqual([
			{ sessionUpdate: "state_update", state: "running" },
			{ sessionUpdate: "state_update", state: "requires_action" },
			{ sessionUpdate: "state_update", state: "running" },
			{ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
		]);
	});

	it("idle carries usage when given", () => {
		const { updates, state } = collect();
		state.running();
		state.idle({
			stopReason: "end_turn",
			usage: { totalTokens: 10, inputTokens: 6, outputTokens: 4 },
		});
		expect(updates[1]).toEqual({
			sessionUpdate: "state_update",
			state: "idle",
			stopReason: "end_turn",
			usage: { totalTokens: 10, inputTokens: 6, outputTokens: 4 },
		});
	});
});
