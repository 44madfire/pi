/**
 * Built-in permission gate for ACP mode.
 *
 * pi core runs every tool call ungated when no `tool_call` handler exists, so
 * the ACP session extension registers this gate (one instance per ACP session)
 * as its `tool_call` handler. Calls needing approval become v2
 * `session/request_permission` requests with `allow_once` / `allow_always` /
 * `reject_once` / `reject_always` options; the `*_always` outcomes are cached
 * for the rest of the session.
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk/experimental/v2";
import type { ToolCallEvent, ToolCallEventResult, ToolInfo } from "../../../core/extensions/types.ts";
import type { ClientPort, DescribeToolCall, GateDecision, GateObserver } from "../core/types.ts";

/** Tools pi ships without MCP annotations that are always safe to run. */
const ALWAYS_ALLOW: Record<string, true> = { read: true, grep: true, find: true, ls: true };

/** Built-in tools that always ask, regardless of annotations. */
const ALWAYS_ASK: Record<string, true> = { edit: true, write: true, bash: true, powershell: true };

export interface PermissionGateOptions {
	describeToolCall: DescribeToolCall;
	/** `--approve-all`: bypass the gate entirely. */
	approveAll: boolean;
}

export interface PermissionGateSession {
	client: ClientPort;
	observer: GateObserver;
	/** Working directory of the session issuing the call. */
	cwd: string;
}

/**
 * One session's approval state. The `*_always` cache lives on the instance;
 * the client port and observer ride per call so the `tool_call` hook site
 * stays a one-liner with no extra closure state.
 */
export class PermissionGate {
	private readonly describeToolCall: DescribeToolCall;
	private readonly approveAll: boolean;
	/** Session-scoped `allow_always` / `reject_always` cache, keyed per {@link cacheKeyFor}. */
	private readonly alwaysCache = new Map<string, boolean>();
	/** Abort controllers of currently open permission asks, for {@link cancelPending}. */
	private readonly pendingAsks = new Set<AbortController>();

	constructor(options: PermissionGateOptions) {
		this.describeToolCall = options.describeToolCall;
		this.approveAll = options.approveAll;
	}

	/**
	 * Gate one tool call. Returns `undefined` to let it run, `{ block: true }`
	 * to block it. Reports `onDecision` for every call, including allowed
	 * calls that never asked. Nested calls (`parentToolCallId` set) are gated
	 * the same way as model-issued calls.
	 *
	 * `session.tools` carries the session's tool info for the annotation rule;
	 * pass `session.getToolInfo` (usually `AgentSession.getAllTools` bound, or
	 * the extension `pi.getAllTools()` snapshot) — when absent, unknown tools
	 * ask.
	 */
	async handle(
		event: ToolCallEvent,
		session: PermissionGateSession & { tools?: readonly ToolInfo[] },
		signal?: AbortSignal,
	): Promise<ToolCallEventResult | undefined> {
		const { toolCallId, toolName } = event;
		const observer = session.observer;

		if (this.approveAll) {
			return this.allow(observer, toolCallId);
		}

		const cacheKey = cacheKeyFor(event);
		const cached = this.alwaysCache.get(cacheKey);
		if (cached !== undefined) {
			return cached
				? this.allow(observer, toolCallId)
				: this.deny(observer, event, `Rejected by a previous "reject always" decision for ${cacheKey}.`);
		}

		if (ALWAYS_ALLOW[toolName]) {
			return this.allow(observer, toolCallId);
		}

		if (!ALWAYS_ASK[toolName] && isReadOnlyTool(session.tools, toolName)) {
			return this.allow(observer, toolCallId);
		}

		return this.ask(event, session, signal);
	}

	/**
	 * Deny every currently open permission ask. The pending `handle` calls
	 * resolve to `{ block: true }` with `onDecision` reported. The session
	 * host calls this from `session/cancel` before `abort()`, because
	 * `abort()` does not settle while a `tool_call` hook is pending.
	 */
	cancelPending(): void {
		for (const controller of this.pendingAsks) {
			controller.abort();
		}
	}

	private allow(observer: GateObserver, toolCallId: string): undefined {
		observer.onDecision({ toolCallId, allowed: true });
		return undefined;
	}

	private deny(observer: GateObserver, event: ToolCallEvent, reason: string): ToolCallEventResult {
		const decision: GateDecision = { toolCallId: event.toolCallId, allowed: false, reason };
		observer.onDecision(decision);
		return { block: true, reason };
	}

	private async ask(
		event: ToolCallEvent,
		session: PermissionGateSession,
		signal: AbortSignal | undefined,
	): Promise<ToolCallEventResult | undefined> {
		const { toolCallId, toolName } = event;
		const observer = session.observer;
		observer.onAsking(toolCallId);

		const controller = new AbortController();
		this.pendingAsks.add(controller);
		const onParentAbort = (): void => controller.abort();
		if (signal !== undefined) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", onParentAbort, { once: true });
		}
		try {
			if (controller.signal.aborted) {
				return this.deny(observer, event, `The ${toolName} tool call was not approved.`);
			}
			const presentation = this.describeToolCall(toolName, event.input, session.cwd);
			const request: Omit<RequestPermissionRequest, "sessionId"> = {
				title: presentation.title,
				description: describeGateCall(event),
				subject: {
					type: "tool_call",
					toolCall: {
						toolCallId,
						name: toolName,
						title: presentation.title,
						kind: presentation.kind,
						locations: presentation.locations,
						rawInput: event.input,
					},
				},
				options: [
					{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
					{ optionId: "allow_always", name: "Allow always", kind: "allow_always" },
					{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
					{ optionId: "reject_always", name: "Reject always", kind: "reject_always" },
				],
			};
			const response = await raceWithAbort(
				session.client.requestPermission(request, controller.signal),
				controller.signal,
			);
			if (response === undefined) {
				return this.deny(observer, event, `The ${toolName} tool call was not approved.`);
			}
			return this.resolveOutcome(observer, event, response);
		} catch {
			// Unknown, cancelled, or failed requests resolve as deny.
			return this.deny(observer, event, `The ${toolName} tool call was not approved.`);
		} finally {
			signal?.removeEventListener("abort", onParentAbort);
			this.pendingAsks.delete(controller);
		}
	}

	private resolveOutcome(
		observer: GateObserver,
		event: ToolCallEvent,
		response: RequestPermissionResponse,
	): ToolCallEventResult | undefined {
		const outcome = response.outcome;
		if (outcome.outcome !== "selected") {
			return this.deny(observer, event, `The ${event.toolName} tool call was not approved.`);
		}
		const key = cacheKeyFor(event);
		switch (outcome.optionId) {
			case "allow_once":
				return this.allow(observer, event.toolCallId);
			case "allow_always":
				this.alwaysCache.set(key, true);
				return this.allow(observer, event.toolCallId);
			case "reject_always":
				this.alwaysCache.set(key, false);
				return this.deny(observer, event, `The user rejected the ${event.toolName} tool call.`);
			default:
				// reject_once and unknown option ids resolve as deny.
				return this.deny(observer, event, `The user rejected the ${event.toolName} tool call.`);
		}
	}
}

/**
 * Cache key for `allow_always` / `reject_always`. Shell tools are keyed by
 * executable (the first command word), everything else by tool name.
 */
function cacheKeyFor(event: ToolCallEvent): string {
	if ((event.toolName === "bash" || event.toolName === "powershell") && isCommandInput(event.input)) {
		return `${event.toolName}:${firstCommandWord(event.input.command)}`;
	}
	return event.toolName;
}

function isCommandInput(input: unknown): input is { command: string } {
	if (input === null || typeof input !== "object" || !("command" in input)) return false;
	return typeof input.command === "string";
}

function firstCommandWord(command: string): string {
	return command.trim().split(/\s+/, 1)[0] ?? "";
}

/** Annotations rule for tools outside the built-in table. */
function isReadOnlyTool(tools: readonly ToolInfo[] | undefined, toolName: string): boolean {
	const info = tools?.find((tool) => tool.name === toolName);
	if (info?.annotations === undefined) return false;
	return info.annotations.readOnlyHint === true && info.annotations.destructiveHint !== true;
}

function describeGateCall(event: ToolCallEvent): string {
	if ((event.toolName === "bash" || event.toolName === "powershell") && isCommandInput(event.input)) {
		return event.input.command;
	}
	return `${event.toolName} ${JSON.stringify(event.input)}`;
}

/**
 * Settle a permission ask when the gate aborts it, without waiting for the
 * peer: `$/cancel_request` is cooperative, so the response may never arrive.
 * Returns undefined when the abort won.
 */
function raceWithAbort(
	request: Promise<RequestPermissionResponse>,
	signal: AbortSignal,
): Promise<RequestPermissionResponse | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	const { promise, resolve } = Promise.withResolvers<RequestPermissionResponse | undefined>();
	const onAbort = (): void => {
		signal.removeEventListener("abort", onAbort);
		resolve(undefined);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	void request.then(
		(response) => {
			signal.removeEventListener("abort", onAbort);
			resolve(response);
		},
		() => {
			signal.removeEventListener("abort", onAbort);
			resolve(undefined);
		},
	);
	return promise;
}
