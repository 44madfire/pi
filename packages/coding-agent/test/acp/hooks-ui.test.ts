/**
 * UI bridge tests: elicitation and permission paths, cancellation, hooks.
 */

import type {
	CreateElicitationRequest,
	CreateElicitationResponse,
	ElicitationSchema,
	RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2";
import { describe, expect, it, vi } from "vitest";
import type { ClientPort } from "../../src/modes/acp/core/types.ts";
import { createUiBridge } from "../../src/modes/acp/pi/ui-bridge.ts";

function formSchema(request: CreateElicitationRequest): ElicitationSchema {
	expect(request.mode).toBe("form");
	const schema = (request as unknown as { requestedSchema: ElicitationSchema }).requestedSchema;
	expect(schema).toBeDefined();
	return schema;
}

function selected(optionId: string): RequestPermissionResponse {
	return { outcome: { outcome: "selected", optionId } };
}

function accept(content: Record<string, string | boolean>): CreateElicitationResponse {
	return { action: "accept", content };
}

interface BridgeHarness {
	client: ClientPort & {
		permissionRequests: Array<{ title: string; options: Array<{ optionId: string; name: string; kind: string }> }>;
		elicitationRequests: CreateElicitationRequest[];
	};
	permissionResponder: (response: RequestPermissionResponse) => void;
	elicitationResponder: (response: CreateElicitationResponse) => void;
	asked: number;
	answered: number;
}

function bridgeHarness(withElicitation: boolean): BridgeHarness {
	const h: BridgeHarness = {
		client: {
			permissionRequests: [],
			elicitationRequests: [],
			requestPermission: async (request) => {
				h.client.permissionRequests.push({
					title: request.title,
					options: request.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
				});
				return new Promise<RequestPermissionResponse>((resolve) => {
					h.permissionResponder = resolve;
				});
			},
		},
		permissionResponder: () => {},
		elicitationResponder: () => {},
		asked: 0,
		answered: 0,
	};
	if (withElicitation) {
		h.client.createElicitation = async (request) => {
			h.client.elicitationRequests.push(request);
			return new Promise<CreateElicitationResponse>((resolve) => {
				h.elicitationResponder = resolve;
			});
		};
	}
	return h;
}

function bridgeFor(h: BridgeHarness) {
	return createUiBridge(h.client, {
		onAsking: () => h.asked++,
		onAnswered: () => h.answered++,
	});
}

describe("ui bridge with elicitation", () => {
	it("select goes to a form with an enum of the choices", async () => {
		const h = bridgeHarness(true);
		const ui = bridgeFor(h);
		const pending = ui.select("Pick one", ["alpha", "beta"]);
		await vi.waitFor(() => expect(h.client.elicitationRequests).toHaveLength(1));
		expect(h.client.permissionRequests).toHaveLength(0);
		const request = h.client.elicitationRequests[0];
		expect(request).toMatchObject({ mode: "form", message: "Pick one" });
		expect(formSchema(request).properties?.choice).toMatchObject({
			type: "string",
			enum: ["alpha", "beta"],
		});
		h.elicitationResponder(accept({ choice: "beta" }));
		await expect(pending).resolves.toBe("beta");
		expect(h.asked).toBe(1);
		expect(h.answered).toBe(1);
	});

	it("select resolves undefined on decline or an unknown value", async () => {
		const h = bridgeHarness(true);
		const ui = bridgeFor(h);
		const first = ui.select("Pick", ["a"]);
		await vi.waitFor(() => expect(h.client.elicitationRequests).toHaveLength(1));
		h.elicitationResponder({ action: "decline" });
		await expect(first).resolves.toBeUndefined();

		const second = ui.select("Pick", ["a"]);
		await vi.waitFor(() => expect(h.client.elicitationRequests).toHaveLength(2));
		h.elicitationResponder(accept({ choice: "zzz" }));
		await expect(second).resolves.toBeUndefined();
		expect(h.answered).toBe(2);
	});

	it("confirm goes to a boolean form", async () => {
		const h = bridgeHarness(true);
		const ui = bridgeFor(h);
		const pending = ui.confirm("Sure?", "really sure?");
		await vi.waitFor(() => expect(h.client.elicitationRequests).toHaveLength(1));
		const request = h.client.elicitationRequests[0];
		expect(formSchema(request).properties?.confirmed).toMatchObject({ type: "boolean" });
		h.elicitationResponder(accept({ confirmed: true }));
		await expect(pending).resolves.toBe(true);
	});

	it("confirm resolves false on decline", async () => {
		const h = bridgeHarness(true);
		const ui = bridgeFor(h);
		const pending = ui.confirm("Sure?", "x");
		await vi.waitFor(() => expect(h.client.elicitationRequests).toHaveLength(1));
		h.elicitationResponder({ action: "cancel" });
		await expect(pending).resolves.toBe(false);
	});

	it("input and editor go to string forms", async () => {
		const h = bridgeHarness(true);
		const ui = bridgeFor(h);
		const inputPending = ui.input("Name?", "placeholder-hint");
		await vi.waitFor(() => expect(h.client.elicitationRequests).toHaveLength(1));
		h.elicitationResponder(accept({ text: "typed" }));
		await expect(inputPending).resolves.toBe("typed");

		const editorPending = ui.editor("Edit it", "prefill");
		await vi.waitFor(() => expect(h.client.elicitationRequests).toHaveLength(2));
		const editorRequest = h.client.elicitationRequests[1];
		expect(formSchema(editorRequest).properties?.text).toMatchObject({
			type: "string",
			default: "prefill",
		});
		h.elicitationResponder(accept({ text: "edited" }));
		await expect(editorPending).resolves.toBe("edited");
	});
});

describe("ui bridge without elicitation", () => {
	it("select maps to one permission option per choice", async () => {
		const h = bridgeHarness(false);
		const ui = bridgeFor(h);
		const pending = ui.select("Pick one", ["alpha", "beta"]);
		await vi.waitFor(() => expect(h.client.permissionRequests).toHaveLength(1));
		expect(h.client.permissionRequests[0].options).toEqual([
			{ optionId: "0", name: "alpha", kind: "other" },
			{ optionId: "1", name: "beta", kind: "other" },
		]);
		h.permissionResponder(selected("1"));
		await expect(pending).resolves.toBe("beta");
	});

	it("select resolves undefined when cancelled", async () => {
		const h = bridgeHarness(false);
		const ui = bridgeFor(h);
		const pending = ui.select("Pick", ["a", "b"]);
		await vi.waitFor(() => expect(h.client.permissionRequests).toHaveLength(1));
		h.permissionResponder({ outcome: { outcome: "cancelled" } });
		await expect(pending).resolves.toBeUndefined();
	});

	it("confirm maps to allow/reject options", async () => {
		const h = bridgeHarness(false);
		const ui = bridgeFor(h);
		const pending = ui.confirm("Sure?", "do it?");
		await vi.waitFor(() => expect(h.client.permissionRequests).toHaveLength(1));
		expect(h.client.permissionRequests[0].options).toEqual([
			{ optionId: "allow", name: "Allow", kind: "allow_once" },
			{ optionId: "reject", name: "Reject", kind: "reject_once" },
		]);
		h.permissionResponder(selected("allow"));
		await expect(pending).resolves.toBe(true);
	});

	it("confirm resolves false on reject or cancel", async () => {
		const h = bridgeHarness(false);
		const ui = bridgeFor(h);
		const first = ui.confirm("A?", "x");
		await vi.waitFor(() => expect(h.client.permissionRequests).toHaveLength(1));
		h.permissionResponder(selected("reject"));
		await expect(first).resolves.toBe(false);

		const second = ui.confirm("B?", "y");
		await vi.waitFor(() => expect(h.client.permissionRequests).toHaveLength(2));
		h.permissionResponder({ outcome: { outcome: "cancelled" } });
		await expect(second).resolves.toBe(false);
	});

	it("input and editor are cancelled without elicitation", async () => {
		const h = bridgeHarness(false);
		const ui = bridgeFor(h);
		await expect(ui.input("Name?")).resolves.toBeUndefined();
		await expect(ui.editor("Edit")).resolves.toBeUndefined();
		expect(h.client.permissionRequests).toHaveLength(0);
		// No request was sent, so the asking hooks never fired.
		expect(h.asked).toBe(0);
		expect(h.answered).toBe(0);
	});

	it("calls onAsking/onAnswered around each permission request", async () => {
		const h = bridgeHarness(false);
		const ui = bridgeFor(h);
		const pending = ui.select("Pick", ["a"]);
		await vi.waitFor(() => expect(h.asked).toBe(1));
		expect(h.answered).toBe(0);
		h.permissionResponder(selected("0"));
		await pending;
		expect(h.answered).toBe(1);
	});
});

describe("ui bridge no-ops", () => {
	it("notify and status go to stderr; terminal/widget/theme calls no-op", () => {
		const h = bridgeHarness(false);
		const ui = bridgeFor(h);
		const writes: string[] = [];
		const original = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			ui.notify("hello");
			ui.notify("watch out", "warning");
			ui.setStatus("key", "working");
			ui.setStatus("key", undefined);
		} finally {
			process.stderr.write = original;
		}
		expect(writes.join("")).toContain("hello");
		expect(writes.join("")).toContain("watch out");

		expect(ui.onTerminalInput(() => undefined)).toBeTypeOf("function");
		ui.setWorkingMessage("x");
		ui.setWorkingVisible(true);
		ui.setWorkingIndicator({ frames: [] });
		ui.setHiddenThinkingLabel("t");
		ui.setWidget("k", undefined);
		ui.setFooter(undefined);
		ui.setHeader(undefined);
		ui.setTitle("t");
		ui.pasteToEditor("x");
		ui.setEditorText("x");
		expect(ui.getEditorText()).toBe("");
		ui.addAutocompleteProvider((current) => current);
		ui.setEditorComponent(undefined);
		expect(ui.getEditorComponent()).toBeUndefined();
		expect(ui.getAllThemes()).toEqual([]);
		expect(ui.getTheme("x")).toBeUndefined();
		expect(ui.setTheme("x").success).toBe(false);
		expect(ui.getToolsExpanded()).toBe(false);
		ui.setToolsExpanded(true);
	});
});
