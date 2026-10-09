/**
 * Extension UI bridge for ACP mode.
 *
 * Extensions are bound with `mode: "rpc"` so they take non-TUI dialog paths.
 * `select`/`confirm` go to form elicitation when the client advertises it,
 * else to `request_permission` with one option per choice; `input`/`editor`
 * need elicitation (there is no free-text permission shape) and resolve as
 * cancelled without it. Everything else is a no-op: ACP has no channel for
 * terminal input, widgets, footers, or theme control.
 */
import type {
	CreateElicitationRequest,
	CreateElicitationResponse,
	ElicitationContentValue,
	ElicitationSchema,
	PermissionOption,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../../core/extensions/types.ts";
import { theme } from "../../interactive/theme/theme.ts";
import type { ClientPort } from "../core/types.ts";

export interface UiBridgeHooks {
	/** A user-facing request is about to be sent (v2: `state_update: requires_action`). */
	onAsking(): void;
	/** The request settled (v2: `state_update: running`). */
	onAnswered(): void;
}

/**
 * Build the `ExtensionUIContext` for one ACP session. `client` is the
 * session's port; `createElicitation` is present only when the client
 * advertised form elicitation.
 */
export function createUiBridge(client: ClientPort, hooks: UiBridgeHooks): ExtensionUIContext {
	const elicitation = client.createElicitation;

	const aroundAsk = async <T>(
		opts: ExtensionUIDialogOptions | undefined,
		run: (signal: AbortSignal) => Promise<T>,
	): Promise<T> => {
		hooks.onAsking();
		try {
			return await run(dialogSignal(opts));
		} finally {
			hooks.onAnswered();
		}
	};

	return {
		select: async (
			title: string,
			options: string[],
			opts?: ExtensionUIDialogOptions,
		): Promise<string | undefined> => {
			if (options.length === 0) return undefined;
			return aroundAsk(opts, async (signal) => {
				if (elicitation !== undefined) {
					const response = await elicitation(
						formRequest(title, {
							type: "object",
							properties: { choice: { type: "string", enum: options } },
							required: ["choice"],
						}),
						signal,
					);
					const choice = elicitedValue(response, "choice");
					return typeof choice === "string" && options.includes(choice) ? choice : undefined;
				}
				const permissionOptions: PermissionOption[] = options.map((option, index) => ({
					optionId: String(index),
					name: option,
					kind: "other",
				}));
				const response = await client.requestPermission({ title, options: permissionOptions }, signal);
				if (response.outcome.outcome !== "selected") return undefined;
				return options[Number(response.outcome.optionId)];
			});
		},

		confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> => {
			return aroundAsk(opts, async (signal) => {
				if (elicitation !== undefined) {
					const response = await elicitation(
						formRequest(`${title}\n${message}`, {
							type: "object",
							properties: { confirmed: { type: "boolean", default: false } },
							required: ["confirmed"],
						}),
						signal,
					);
					return elicitedValue(response, "confirmed") === true;
				}
				const response = await client.requestPermission(
					{
						title,
						description: message,
						options: [
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
							{ optionId: "reject", name: "Reject", kind: "reject_once" },
						],
					},
					signal,
				);
				return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
			});
		},

		input: async (
			title: string,
			placeholder?: string,
			opts?: ExtensionUIDialogOptions,
		): Promise<string | undefined> => {
			if (elicitation === undefined) return undefined;
			return aroundAsk(opts, async (signal) => {
				const response = await elicitation(
					formRequest(title, {
						type: "object",
						properties: {
							text: {
								type: "string",
								...(placeholder === undefined ? {} : { description: placeholder }),
							},
						},
						required: ["text"],
					}),
					signal,
				);
				const text = elicitedValue(response, "text");
				return typeof text === "string" ? text : undefined;
			});
		},

		notify: (message: string, type?: "info" | "warning" | "error"): void => {
			// ACP has no extension-notification channel; stderr keeps it visible
			// without corrupting the stdout protocol stream.
			const prefix = type === undefined || type === "info" ? "note" : type;
			process.stderr.write(`[acp extension ${prefix}] ${message}\n`);
		},

		onTerminalInput: () => () => {},

		setStatus: (key: string, text: string | undefined): void => {
			if (text !== undefined) process.stderr.write(`[acp extension status ${key}] ${text}\n`);
		},

		setWorkingMessage: (): void => {},
		setWorkingVisible: (): void => {},
		setWorkingIndicator: (): void => {},
		setHiddenThinkingLabel: (): void => {},

		setWidget: (): void => {},
		setFooter: (): void => {},
		setHeader: (): void => {},
		setTitle: (): void => {},

		custom: async () => undefined as never,

		pasteToEditor: (): void => {},
		setEditorText: (): void => {},
		getEditorText: (): string => "",

		editor: async (title: string, prefill?: string): Promise<string | undefined> => {
			if (elicitation === undefined) return undefined;
			return aroundAsk(undefined, async (signal) => {
				const response = await elicitation(
					formRequest(title, {
						type: "object",
						properties: {
							text: {
								type: "string",
								...(prefill === undefined ? {} : { default: prefill }),
							},
						},
						required: ["text"],
					}),
					signal,
				);
				const text = elicitedValue(response, "text");
				return typeof text === "string" ? text : undefined;
			});
		},

		addAutocompleteProvider: (): void => {},
		setEditorComponent: (): void => {},
		getEditorComponent: () => undefined,

		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not supported in ACP mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: (): void => {},
	};
}

/**
 * Session-scoped form request. The UI bridge never knows the session id (the
 * wire adapter owns it), so the request is built up to the scope and the
 * session's ClientPort fills the scope in before sending.
 */
function formRequest(message: string, requestedSchema: ElicitationSchema): CreateElicitationRequest {
	return { mode: "form", message, requestedSchema } as CreateElicitationRequest;
}

function elicitedValue(response: CreateElicitationResponse, key: string): ElicitationContentValue | undefined {
	if (response.action !== "accept") return undefined;
	const content = response.content as Record<string, ElicitationContentValue> | null | undefined;
	return content?.[key];
}

/**
 * The signal for one dialog's ClientPort call: aborts when the caller's
 * signal aborts or the dialog timeout elapses, so the request aborts and the
 * dialog resolves with its cancelled value.
 */
function dialogSignal(opts: ExtensionUIDialogOptions | undefined): AbortSignal {
	if (opts?.signal === undefined && opts?.timeout === undefined) {
		return new AbortController().signal;
	}
	const controller = new AbortController();
	if (opts?.signal !== undefined) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	if (opts?.timeout !== undefined) {
		setTimeout(() => controller.abort(), opts.timeout).unref?.();
	}
	return controller.signal;
}
