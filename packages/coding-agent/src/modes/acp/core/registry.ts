import { unlink } from "node:fs/promises";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "../../../core/agent-session-runtime.ts";
import { createAgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import { formatNoModelsAvailableMessage } from "../../../core/auth-guidance.ts";
import { type SessionInfo as PiSessionInfo, SessionManager } from "../../../core/session-manager.ts";
import { resolvePath } from "../../../utils/paths.ts";

export interface AcpRegistryOptions {
	sessionDir?: string;
}

export class AcpSessionRegistry {
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly agentDir: string;
	private readonly sessionDir: string | undefined;
	private readonly runtimes = new Map<string, AgentSessionRuntime>();
	private initialRuntime: AgentSessionRuntime | undefined;

	constructor(
		initialRuntime: AgentSessionRuntime,
		createRuntime: CreateAgentSessionRuntimeFactory,
		options: AcpRegistryOptions = {},
	) {
		this.initialRuntime = initialRuntime;
		this.createRuntime = createRuntime;
		this.agentDir = initialRuntime.services.agentDir;
		this.sessionDir = options.sessionDir;
	}

	get(sessionId: string): AgentSessionRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.runtimes.has(sessionId);
	}

	liveSessionIds(): string[] {
		return [...this.runtimes.keys()];
	}

	/**
	 * Create a new ACP session for `cwd`, adopting the initial runtime when its
	 * session is still empty and already targets that cwd. Throws when the new
	 * session has no usable model.
	 */
	async create(cwd: string): Promise<AgentSessionRuntime> {
		const resolvedCwd = resolvePath(cwd);
		const initial = this.initialRuntime;
		if (initial !== undefined) {
			this.initialRuntime = undefined;
			if (resolvePath(initial.cwd) === resolvedCwd && initial.session.sessionManager.getEntryCount() === 0) {
				this.assertUsableModel(initial);
				this.runtimes.set(initial.session.sessionId, initial);
				return initial;
			}
			await initial.dispose();
		}
		const sessionManager = SessionManager.create(resolvedCwd, this.sessionDir);
		const runtime = await createAgentSessionRuntime(this.createRuntime, {
			cwd: resolvedCwd,
			agentDir: this.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new" },
		});
		this.assertUsableModel(runtime);
		this.runtimes.set(runtime.session.sessionId, runtime);
		return runtime;
	}

	/**
	 * Open the persisted pi session `sessionId` for `cwd`. Throws when the
	 * session is unknown, belongs to a different cwd, or has no usable model.
	 */
	async resume(sessionId: string, cwd: string): Promise<AgentSessionRuntime> {
		const existing = this.runtimes.get(sessionId);
		if (existing !== undefined) {
			if (resolvePath(existing.cwd) !== resolvePath(cwd)) {
				throw new Error(`Session "${sessionId}" belongs to a different working directory`);
			}
			return existing;
		}
		const path = SessionManager.findById(cwd, sessionId, this.sessionDir);
		if (path === undefined) {
			throw new Error(`Unknown session "${sessionId}"`);
		}
		if (this.initialRuntime !== undefined) {
			await this.initialRuntime.dispose();
			this.initialRuntime = undefined;
		}
		const sessionManager = SessionManager.open(path, this.sessionDir);
		const runtime = await createAgentSessionRuntime(this.createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: this.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume" },
		});
		if (runtime.session.sessionId !== sessionId) {
			await runtime.dispose();
			throw new Error(`Session file mismatch for "${sessionId}"`);
		}
		this.assertUsableModel(runtime);
		this.runtimes.set(sessionId, runtime);
		return runtime;
	}

	async close(sessionId: string): Promise<boolean> {
		const runtime = this.runtimes.get(sessionId);
		if (runtime === undefined) {
			return false;
		}
		this.runtimes.delete(sessionId);
		await runtime.session.abort();
		await runtime.dispose();
		return true;
	}

	/**
	 * Delete a session from `session/list`: closes the live runtime when
	 * present and removes the persisted file. The v2 spec only says "deleting
	 * an existing session from `session/list`", with no loaded/unloaded
	 * distinction, so deleting a loaded session closes it first rather than
	 * being rejected. Also handles persisted-but-unloaded sessions (not in
	 * `runtimes`) via `list()`. Returns false when unknown.
	 */
	async delete(sessionId: string): Promise<boolean> {
		const runtime = this.runtimes.get(sessionId);
		const liveFile = runtime?.session.sessionFile;
		if (runtime !== undefined) {
			this.runtimes.delete(sessionId);
			await runtime.session.abort();
			await runtime.dispose();
		} else if (this.initialRuntime?.session.sessionId === sessionId) {
			const initial = this.initialRuntime;
			this.initialRuntime = undefined;
			await initial.dispose();
		}
		if (liveFile !== undefined) {
			await unlink(liveFile).catch(() => {});
			return true;
		}
		if (runtime !== undefined) {
			// Live-but-unpersisted sessions (adopted initial runtime, lazy file
			// creation) have no file to remove; closing the runtime deletes them.
			return true;
		}
		for (const info of await this.list()) {
			if (info.id === sessionId && info.path !== "") {
				await unlink(info.path).catch(() => {});
				return true;
			}
		}
		return false;
	}

	async list(cwd?: string): Promise<PiSessionInfo[]> {
		const stored =
			cwd === undefined
				? await SessionManager.listAll(this.sessionDir)
				: await SessionManager.list(cwd, this.sessionDir);
		const seen = new Set(stored.map((info) => info.id));
		const live: PiSessionInfo[] = [];
		for (const runtime of this.runtimes.values()) {
			const manager = runtime.session.sessionManager;
			const id = manager.getSessionId();
			if (seen.has(id)) continue;
			// Live-but-unpersisted sessions (adopted initial runtime, or a new
			// session whose file is created lazily on first conversation).
			if (cwd !== undefined && resolvePath(runtime.cwd) !== resolvePath(cwd)) continue;
			seen.add(id);
			live.push({
				path: manager.getSessionFile() ?? "",
				id,
				cwd: runtime.cwd,
				name: runtime.session.sessionName,
				created: new Date(),
				modified: new Date(),
				messageCount: manager.getEntryCount(),
				firstMessage: "",
				allMessagesText: "",
			});
		}
		return [...stored, ...live];
	}

	/** Dispose every runtime, including an unadopted initial runtime. */
	async disposeAll(): Promise<void> {
		const runtimes = [...this.runtimes.values()];
		this.runtimes.clear();
		const initial = this.initialRuntime;
		this.initialRuntime = undefined;
		for (const runtime of runtimes) {
			await runtime.session.abort();
			await runtime.dispose();
		}
		if (initial !== undefined) {
			await initial.dispose();
		}
	}

	private assertUsableModel(runtime: AgentSessionRuntime): void {
		if (runtime.session.model === undefined) {
			throw new Error(formatNoModelsAvailableMessage());
		}
	}
}
