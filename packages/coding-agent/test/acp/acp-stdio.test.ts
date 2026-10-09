/**
 * P1 acceptance: real `pi --mode acp` process over stdio.
 *
 * Spawns the built CLI with the fixture provider extension, drives
 * initialize/new/prompt with the v2 SDK client, and asserts stdout isolation
 * (every raw stdout line parses as JSON-RPC, tool noise lands on stderr),
 * idle end_turn, and exit 0 on stdin end.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk/experimental/v2";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/acp-faux-provider.ts", import.meta.url));

interface Child {
	process: ChildProcess;
	stdoutLines: string[];
	stderrText: () => string;
}

function spawnAcp(cwd: string): Child {
	const child = spawn(
		process.execPath,
		[
			CLI,
			"--mode",
			"acp",
			"--no-session",
			"--offline",
			"--approve-all",
			"-e",
			FIXTURE,
			"--model",
			"acp-faux/acp-faux-1",
		],
		{ cwd, stdio: ["pipe", "pipe", "pipe"] },
	);
	const stdoutLines: string[] = [];
	let stdoutBuffer = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdoutBuffer += chunk.toString("utf-8");
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length > 0) stdoutLines.push(line);
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf-8");
	});
	return { process: child, stdoutLines, stderrText: () => stderr };
}

describe("acp stdio acceptance", () => {
	const children: ChildProcess[] = [];
	afterEach(() => {
		while (children.length > 0) {
			const child = children.pop();
			if (child !== undefined && child.exitCode === null && child.signalCode === null) {
				child.kill();
			}
		}
	});

	it("stdio: valid JSON-RPC frames, noise on stderr, idle end_turn, exit 0 on stdin end", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-acp-stdio-"));
		const child = spawnAcp(cwd);
		children.push(child.process);

		const updates: SessionUpdate[] = [];
		const idleSeen = Promise.withResolvers<StopReason | null | undefined>();
		const clientApp = client({ name: "stdio-acceptance" })
			.onNotification(methods.client.session.update, ({ params }) => {
				updates.push(params.update);
				if (params.update.sessionUpdate === "state_update" && params.update.state === "idle") {
					idleSeen.resolve((params.update as unknown as { stopReason?: StopReason | null }).stopReason);
				}
			})
			.onRequest(methods.client.session.requestPermission, () => ({
				outcome: { outcome: "selected", optionId: "allow_once" },
			}));

		const input = Writable.toWeb(child.process.stdin as Writable) as WritableStream<Uint8Array>;
		const output = Readable.toWeb(child.process.stdout as Readable) as ReadableStream<Uint8Array>;
		const stream = ndJsonStream(input, output);
		const exitCode = Promise.withResolvers<number | null>();

		await clientApp.connectWith(stream, async (ctx) => {
			const init = await ctx.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				info: { name: "stdio-acceptance", version: "0.0.0" },
				capabilities: {},
			});
			expect(init.protocolVersion).toBe(PROTOCOL_VERSION);

			const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
			expect(typeof created.sessionId).toBe("string");

			const response = await ctx.request(methods.agent.session.prompt, {
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "run the fixture tool" }],
			});
			expect(typeof response.messageId).toBe("string");

			const stopReason = await idleSeen.promise;
			expect(stopReason).toBe("end_turn");
		});

		// End stdin: the child must exit 0.
		child.process.stdin?.end();
		const code = await new Promise<number | null>((resolve) => {
			child.process.on("exit", (exitCodeValue) => {
				exitCode.resolve(exitCodeValue);
				resolve(exitCodeValue);
			});
			// Genuine wall-clock guard: the platform clock governs child exit.
			setTimeout(() => resolve(child.process.exitCode), 15000);
		});
		expect(code).toBe(0);

		// Every raw stdout line parses as JSON-RPC.
		expect(child.stdoutLines.length).toBeGreaterThan(0);
		for (const line of child.stdoutLines) {
			let parsed: unknown;
			expect(() => {
				parsed = JSON.parse(line) as unknown;
			}).not.toThrow();
			expect(typeof parsed).toBe("object");
			expect(parsed).not.toBeNull();
			expect((parsed as Record<string, unknown>).jsonrpc).toBe("2.0");
		}

		// The fixture tool's stdout noise appears on stderr, never on stdout.
		const stderr = child.stderrText();
		expect(stderr).toContain("NOISY-TOOL");
		expect(child.stdoutLines.some((line) => line.includes("NOISY-TOOL"))).toBe(false);

		// The turn ran the fixture tool to completion.
		const toolUpdates = updates.filter(
			(update): update is SessionUpdate & { sessionUpdate: "tool_call_update"; status?: string | null } =>
				update.sessionUpdate === "tool_call_update",
		);
		expect(toolUpdates.length).toBeGreaterThan(0);
		expect(toolUpdates.at(-1)?.status).toBe("completed");
	});
}, 60000);
