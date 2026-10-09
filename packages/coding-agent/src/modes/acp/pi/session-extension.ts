import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../../core/extensions/types.ts";
import type { FileMutation } from "../core/types.ts";
import { createMutationCapturingTools } from "./tool-ops.ts";

export interface AcpSessionBinding {
	readonly sessionId: string;
	readonly recordMutation: (mutation: FileMutation) => void;
	readonly handleToolCall: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
}

const bindingsBySessionId = new Map<string, AcpSessionBinding>();

/**
 * Register the live binding for a session. Called by the session host before
 * the first prompt; unregistered on close/delete.
 */
export function registerAcpSessionBinding(binding: AcpSessionBinding): void {
	bindingsBySessionId.set(binding.sessionId, binding);
}

export function unregisterAcpSessionBinding(sessionId: string): void {
	bindingsBySessionId.delete(sessionId);
}

function bindingFor(ctx: ExtensionContext): AcpSessionBinding | undefined {
	return bindingsBySessionId.get(ctx.sessionManager.getSessionId());
}

/**
 * Inline extension loaded by every runtime when `appMode === "acp"`.
 *
 * Each runtime loads it once; handlers resolve their per-session binding
 * lazily through `ctx.sessionManager`, so sessions never share gate or
 * mutation state. The `tool_call` hook runs the session's permission gate.
 * The same-name `edit`/`write` registrations override the built-ins (see
 * `AgentSession._refreshToolRegistry`) with definitions that record
 * pre/post file content for ACP diffs and are otherwise identical.
 */
export function createAcpSessionExtension(): InlineExtension {
	return {
		name: "acp-session",
		hidden: true,
		factory: (pi: ExtensionAPI) => {
			pi.on("tool_call", (event, ctx) => bindingFor(ctx)?.handleToolCall(event, ctx));
			for (const tool of createMutationCapturingTools(process.cwd(), (ctx) => bindingFor(ctx)?.recordMutation)) {
				pi.registerTool(tool);
			}
		},
	};
}
