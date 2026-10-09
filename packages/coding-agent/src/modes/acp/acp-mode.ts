import { Readable } from "node:stream";
import { agentProtocolRouter, ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import { writeRawStdout } from "../../core/output-guard.ts";
import { createV2Runtime } from "./wire/v2.ts";

export interface AcpModeOptions {
	approveAll: boolean;
	sessionDir?: string;
}

/**
 * Serve ACP v2 over stdio. main.ts already ran `takeOverStdout()`, so protocol
 * frames go through `writeRawStdout`; everything else lands on stderr.
 */
export async function runAcpMode(
	initialRuntime: AgentSessionRuntime,
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: AcpModeOptions,
): Promise<never> {
	const v2 = createV2Runtime(initialRuntime, createRuntime, options);
	const output = new WritableStream<Uint8Array>({
		write(chunk) {
			writeRawStdout(new TextDecoder().decode(chunk));
		},
	});
	const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	const stream = ndJsonStream(output, input);
	const connection = agentProtocolRouter().withV2(v2.app).connect(stream);

	process.stdin.on("end", () => {
		void v2.disposeAll().finally(() => {
			process.exit(0);
		});
	});

	await connection.closed;
	await v2.disposeAll();
	process.exit(0);
}

export type { AcpV2Options, AcpV2Runtime } from "./wire/v2.ts";
