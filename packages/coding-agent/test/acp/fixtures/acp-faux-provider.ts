/**
 * Fixture extension: scripted provider plus a stdout-noisy tool, for the ACP
 * stdio acceptance test. Modelled on the P0 spike faux provider.
 *
 * Load with: node dist/cli.js --mode acp --no-session --offline
 *   -e test/acp/fixtures/acp-faux-provider.ts
 *   --model acp-faux/acp-faux-1
 *
 * The scripted reply calls the `acp_noisy_tool` fixture tool once, then says
 * done. The tool writes to stdout inside `execute`; output isolation must
 * keep every stdout frame valid JSON-RPC with the noise on stderr.
 */

import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function scriptedMessage(model: { api: string; provider: string; id: string }, callCount: number): AssistantMessage {
	const toolCall: ToolCall[] =
		callCount === 0
			? [{ type: "toolCall", id: "acp-fixture-call-1", name: "acp_noisy_tool", arguments: { text: "fixture-hi" } }]
			: [];
	const text = callCount === 0 ? "calling the fixture tool" : "done";
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: callCount === 0 ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

export default function (pi: ExtensionAPI) {
	let callCount = 0;
	pi.registerProvider(
		createProvider({
			id: "acp-faux",
			auth: { apiKey: { name: "ACP Faux", resolve: async () => ({ auth: {} }) } },
			models: [
				{
					id: "acp-faux-1",
					name: "ACP Faux 1",
					api: "acp-faux-api",
					provider: "acp-faux",
					baseUrl: "http://localhost:0",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8000,
					maxTokens: 1024,
				},
			],
			api: {
				stream: () => {
					throw new Error("acp-faux: stream() not implemented");
				},
				streamSimple: (model, _context, _options) => {
					const stream = createAssistantMessageEventStream();
					const message = scriptedMessage(model, callCount);
					callCount++;
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						if (message.stopReason === "toolUse") {
							stream.push({ type: "done", reason: "toolUse", message });
						} else {
							stream.push({ type: "text_start", contentIndex: 0, partial: message });
							stream.push({
								type: "text_delta",
								contentIndex: 0,
								delta: "done",
								partial: message,
							});
							stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: message });
							stream.push({ type: "done", reason: "stop", message });
						}
					});
					return stream;
				},
			},
		}),
	);

	pi.registerTool({
		name: "acp_noisy_tool",
		label: "ACP Noisy Tool",
		description: "Fixture tool that pollutes stdout when called",
		parameters: { type: "object", properties: { text: { type: "string" } } },
		async execute(_toolCallId: string, params: { text?: unknown }) {
			console.log("NOISY-TOOL: console.log inside fixture tool");
			process.stdout.write("NOISY-TOOL: raw stdout.write inside fixture tool\n");
			const text =
				typeof params === "object" && params !== null && "text" in params && typeof params.text === "string"
					? params.text
					: "?";
			return { content: [{ type: "text", text: `noisy saw: ${text}` }], details: {} };
		},
	});
}
