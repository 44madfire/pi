import type {
	AgentApp,
	AgentContext,
	AvailableCommand,
	ContentBlock,
	NewSessionResponse,
	ResumeSessionResponse,
	SessionConfigOption,
	SessionInfo,
	SessionUpdate,
	SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
	agent,
	ContentBlock as ContentBlockGuard,
	methods,
	PROTOCOL_VERSION,
	RequestError,
	SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { ImageContent as PiImageContent } from "@earendil-works/pi-ai/compat";
import { APP_NAME, VERSION } from "../../../config.ts";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "../../../core/agent-session-runtime.ts";
import { AcpSessionRegistry } from "../core/registry.ts";
import { AcpSessionHost } from "../core/session-host.ts";
import type { ClientPort, CoreUpdate, UpdateSink } from "../core/types.ts";
import { InvalidConfigOptionError } from "../pi/catalogs.ts";

export interface AcpV2Options {
	approveAll: boolean;
	sessionDir?: string;
}

export interface AcpV2Runtime {
	app: AgentApp;
	disposeAll: () => Promise<void>;
}

/**
 * Build the v2 agent app plus a disposer over the shared registry. Stateless
 * wire: every handler resolves its session host, and the host owns pi state.
 */
export function createV2Runtime(
	initialRuntime: AgentSessionRuntime,
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: AcpV2Options,
): AcpV2Runtime {
	const registry = new AcpSessionRegistry(initialRuntime, createRuntime, { sessionDir: options.sessionDir });
	const hosts = new Map<string, AcpSessionHost>();
	let elicitationSupported = false;

	function clientPort(agent: AgentContext, sessionId: string): ClientPort {
		const port: ClientPort = {
			requestPermission: (request, signal) =>
				agent.request(
					methods.client.session.requestPermission,
					{ ...request, sessionId },
					{ cancellationSignal: signal },
				),
		};
		if (elicitationSupported) {
			port.createElicitation = (request, signal) =>
				agent.request(methods.client.elicitation.create, request, { cancellationSignal: signal });
		}
		return port;
	}

	function notifySink(agent: AgentContext, sessionId: string): UpdateSink {
		return (update: CoreUpdate) => {
			void agent.notify(methods.client.session.update, { sessionId, update }).catch((error: unknown) => {
				console.error(
					`[acp] session/update notify failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		};
	}

	async function requireHost(sessionId: string): Promise<AcpSessionHost> {
		const host = hosts.get(sessionId);
		if (host === undefined) {
			throw RequestError.invalidParams(`Unknown session "${sessionId}"`);
		}
		return host;
	}

	async function openHost(agent: AgentContext, runtime: AgentSessionRuntime): Promise<AcpSessionHost> {
		const sessionId = runtime.session.sessionId;
		const existing = hosts.get(sessionId);
		if (existing !== undefined) {
			return existing;
		}
		const host = new AcpSessionHost(runtime, clientPort(agent, sessionId), notifySink(agent, sessionId), {
			approveAll: options.approveAll,
		});
		await host.bind();
		hosts.set(sessionId, host);
		return host;
	}

	async function closeHost(sessionId: string): Promise<boolean> {
		const host = hosts.get(sessionId);
		if (host === undefined) {
			return registry.close(sessionId);
		}
		hosts.delete(sessionId);
		await host.close();
		return true;
	}

	const app = agent({ name: `${APP_NAME}-acp-v2` });

	app.onRequest(methods.agent.initialize, ({ params }) => {
		elicitationSupported =
			params.capabilities?.elicitation?.form !== undefined && params.capabilities.elicitation.form !== null;
		return {
			protocolVersion: PROTOCOL_VERSION,
			info: { name: `${APP_NAME}-acp`, version: VERSION },
			capabilities: {
				session: {
					prompt: { image: {}, embeddedContext: {} },
					delete: {},
				},
			},
		};
	});

	app.onRequest(methods.agent.session.new, async ({ params, client }): Promise<NewSessionResponse> => {
		let runtime: AgentSessionRuntime;
		try {
			runtime = await registry.create(params.cwd);
		} catch (error) {
			throw RequestError.invalidParams(error instanceof Error ? error.message : String(error));
		}
		const host = await openHost(client, runtime);
		const configOptions: SessionConfigOption[] = host.initialConfigOptions();
		const availableCommands: AvailableCommand[] = host.initialCommands();
		return { sessionId: host.sessionId, configOptions, availableCommands };
	});

	app.onRequest(methods.agent.session.list, async ({ params }) => {
		const infos = await registry.list(params.cwd ?? undefined);
		const sessions: SessionInfo[] = infos.map((info) => ({
			sessionId: info.id,
			cwd: info.cwd,
			title: info.name ?? null,
			updatedAt: info.modified.toISOString(),
		}));
		return { sessions };
	});

	app.onRequest(methods.agent.session.resume, async ({ params, client }): Promise<ResumeSessionResponse> => {
		if (params.replayFrom !== undefined && params.replayFrom !== null && params.replayFrom.type !== "start") {
			throw RequestError.invalidParams(`Unsupported replay cursor "${params.replayFrom.type}"`);
		}
		let runtime: AgentSessionRuntime;
		try {
			runtime = await registry.resume(params.sessionId, params.cwd);
		} catch (error) {
			throw RequestError.invalidParams(error instanceof Error ? error.message : String(error));
		}
		const host = await openHost(client, runtime);
		if (params.replayFrom?.type === "start") {
			host.replay();
		}
		const configOptions: SessionConfigOption[] = host.initialConfigOptions();
		const availableCommands: AvailableCommand[] = host.initialCommands();
		return { configOptions, availableCommands };
	});

	app.onRequest(methods.agent.session.close, async ({ params }) => {
		await closeHost(params.sessionId);
	});

	app.onRequest(methods.agent.session.delete, async ({ params }) => {
		hosts.delete(params.sessionId);
		const deleted = await registry.delete(params.sessionId);
		if (!deleted) {
			throw RequestError.invalidParams(`Unknown session "${params.sessionId}"`);
		}
	});

	app.onRequest(methods.agent.session.setConfigOption, async ({ params }): Promise<SetSessionConfigOptionResponse> => {
		const host = await requireHost(params.sessionId);
		if (!SetSessionConfigOptionRequest.isId(params)) {
			throw RequestError.invalidParams(`Unsupported config value type "${params.type}"`);
		}
		try {
			const configOptions = await host.setConfigOption(params.configId, params.value);
			return { configOptions };
		} catch (error: unknown) {
			if (error instanceof Error && error instanceof InvalidConfigOptionError) {
				throw RequestError.invalidParams(error.message);
			}
			throw error;
		}
	});

	app.onRequest(methods.agent.session.prompt, ({ params, client }) => {
		const hostPromise = requireHost(params.sessionId);
		return hostPromise.then((host) => {
			if (host.isTurnActive) {
				throw RequestError.invalidRequest(`Session "${params.sessionId}" is already processing a prompt`);
			}
			const { text, images } = promptToText(params.prompt);
			const messageId = crypto.randomUUID();
			const sessionId = params.sessionId;
			const userMessage: SessionUpdate = { sessionUpdate: "user_message", messageId, content: params.prompt };
			// Queue the response before the turn starts: the first notify lands
			// after this handler returns, so `{messageId}` is written first.
			const turn = Promise.resolve()
				.then(() => client.notify(methods.client.session.update, { sessionId, update: userMessage }))
				.then(() => host.runTurn(text, images.length > 0 ? images : undefined))
				.catch((error: unknown) => {
					console.error(`[acp] turn failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			void turn;
			return { messageId };
		});
	});

	app.onNotification(methods.agent.session.cancel, ({ params }) => {
		const host = hosts.get(params.sessionId);
		if (host !== undefined) {
			void host.cancel().catch((error: unknown) => {
				console.error(`[acp] cancel failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	});

	return {
		app,
		disposeAll: async () => {
			const live = [...hosts.values()];
			hosts.clear();
			for (const host of live) {
				await host.close();
			}
			await registry.disposeAll();
		},
	};
}

function promptToText(prompt: readonly ContentBlock[]): { text: string; images: PiImageContent[] } {
	const parts: string[] = [];
	const images: PiImageContent[] = [];
	for (const block of prompt) {
		if (ContentBlockGuard.isText(block)) {
			parts.push(block.text);
		} else if (ContentBlockGuard.isImage(block)) {
			images.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else if (ContentBlockGuard.isResourceLink(block)) {
			parts.push(block.uri);
		} else if (ContentBlockGuard.isResource(block)) {
			const resource = block.resource;
			if ("text" in resource) {
				parts.push(`[${resource.uri}]\n${resource.text}`);
			} else {
				parts.push(resource.uri);
			}
		}
	}
	return { text: parts.join("\n"), images };
}

export type { AgentApp };
