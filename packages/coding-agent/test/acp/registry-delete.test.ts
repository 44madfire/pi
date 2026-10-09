import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { AcpSessionRegistry } from "../../src/modes/acp/core/registry.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

describe("acp registry delete", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeRegistry(harness: Harness, sessionDir: string): AcpSessionRegistry {
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			throw new Error("registry delete tests create no extra runtimes");
		};
		const initialRuntime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			createRuntime,
		);
		return new AcpSessionRegistry(initialRuntime, createRuntime, { sessionDir });
	}

	it("deletes a persisted-but-unloaded session and removes its file", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-acp-sessions-"));
		tempDirs.push(sessionDir);
		// A persisted session with no live runtime: run a turn so the lazy
		// file is flushed, then drop the harness without disposing the file.
		const strayDir = mkdtempSync(join(tmpdir(), "pi-acp-stray-"));
		tempDirs.push(strayDir);
		const strayManager = SessionManager.create(strayDir, sessionDir);
		const strayHarness = await createHarness({ sessionManager: strayManager });
		harnesses.push(strayHarness);
		strayHarness.setResponses([fauxAssistantMessage("stray")]);
		await strayHarness.session.prompt("hello");
		const strayId = strayManager.getSessionId();
		const strayFile = strayManager.getSessionFile();
		expect(strayFile).toBeDefined();
		expect(existsSync(strayFile!)).toBe(true);

		const harness = await createHarness();
		harnesses.push(harness);
		const registry = makeRegistry(harness, sessionDir);

		expect(await registry.delete(strayId)).toBe(true);
		expect(existsSync(strayFile!)).toBe(false);
		expect((await registry.list()).map((info) => info.id)).not.toContain(strayId);
		await registry.disposeAll();
	});

	it("deleting a loaded session closes it first, then removes its file", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-acp-sessions-"));
		tempDirs.push(sessionDir);
		const liveDir = mkdtempSync(join(tmpdir(), "pi-acp-live-"));
		tempDirs.push(liveDir);
		const liveManager = SessionManager.create(liveDir, sessionDir);
		const harness = await createHarness({ sessionManager: liveManager });
		harnesses.push(harness);
		const registry = makeRegistry(harness, sessionDir);

		const runtime = await registry.create(harness.tempDir);
		const sessionId = runtime.session.sessionId;
		expect(sessionId).toBe(liveManager.getSessionId());
		expect(registry.has(sessionId)).toBe(true);
		// The adopted initial runtime persists lazily; a turn flushes the file.
		harness.setResponses([fauxAssistantMessage("live")]);
		await harness.session.prompt("hello");
		const file = runtime.session.sessionFile;
		expect(file).toBeDefined();
		expect(existsSync(file!)).toBe(true);

		expect(await registry.delete(sessionId)).toBe(true);
		expect(registry.has(sessionId)).toBe(false);
		expect(existsSync(file!)).toBe(false);
		expect((await registry.list()).map((info) => info.id)).not.toContain(sessionId);
		await registry.disposeAll();
	});

	it("returns false for an unknown session", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-acp-sessions-"));
		tempDirs.push(sessionDir);
		const harness = await createHarness();
		harnesses.push(harness);
		const registry = makeRegistry(harness, sessionDir);

		expect(await registry.delete("00000000-0000-0000-0000-000000000000")).toBe(false);
		await registry.disposeAll();
	});
});
