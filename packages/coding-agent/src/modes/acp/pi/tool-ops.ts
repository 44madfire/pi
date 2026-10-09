/**
 * Mutation-capturing edit/write tools and ACP diff content for ACP mode.
 *
 * Same-name `edit`/`write` definitions built from the same factories as the
 * built-ins override them when registered (extension `registerTool`), with a
 * capture wrapper around `execute` so behaviour is identical while pre/post
 * file content is recorded per tool call. The session host turns the
 * recorded mutations into v2 diff content via {@link mutationsToDiffContent}.
 */
import { readFile } from "node:fs/promises";
import type { Diff as AcpDiff, DiffChange, ToolCallContent } from "@agentclientprotocol/sdk/experimental/v2";
import * as Diff from "diff";
import { defineTool, type ExtensionToolContext, type ToolDefinition } from "../../../core/extensions/types.ts";
import { createEditToolDefinition } from "../../../core/tools/edit.ts";
import { resolveToCwd } from "../../../core/tools/path-utils.ts";
import { createWriteToolDefinition } from "../../../core/tools/write.ts";
import type { FileMutation, MutationsToDiffContent } from "../core/types.ts";

async function readText(path: string): Promise<string | null> {
	return readFile(path, "utf-8").catch(() => null);
}

interface EditParams {
	path: string;
}

/**
 * Same-name `edit` and `write` definitions that record pre/post file content.
 * Behaviour is identical to the built-ins: the definitions come from the same
 * factories and the wrapper only reads the file before and after `execute`.
 *
 * `record` receives one mutation per successful call, keyed by the real
 * toolCallId passed to `execute`. `recordFor` resolves the recorder at
 * execute time, so one shared registration can serve many sessions: each
 * call's `ctx` selects its session's recorder. `cwd` is the fallback working
 * directory; per-session cwd flows through `ctx.cwd` at execute time,
 * exactly as with the built-ins.
 */
export function createMutationCapturingTools(
	cwd: string,
	recordFor: (ctx: ExtensionToolContext) => ((mutation: FileMutation) => void) | undefined,
): ToolDefinition[] {
	return [
		defineTool(withMutationCapture(createEditToolDefinition(cwd), cwd, recordFor)),
		defineTool(withMutationCapture(createWriteToolDefinition(cwd), cwd, recordFor)),
	];
}

function withMutationCapture<TParams extends ToolDefinition["parameters"], TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
	cwd: string,
	recordFor: (ctx: ExtensionToolContext) => ((mutation: FileMutation) => void) | undefined,
): ToolDefinition<TParams, TDetails, TState> {
	const innerExecute = definition.execute.bind(definition);
	return {
		...definition,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const record = recordFor(ctx);
			const absolutePath = resolveToCwd((params as EditParams).path, ctx.cwd ?? cwd);
			const oldText = await readText(absolutePath);
			const result = await innerExecute(toolCallId, params, signal, onUpdate, ctx);
			if (result.isError !== true && record !== undefined) {
				const newText = await readText(absolutePath);
				if (newText !== null) {
					record({ toolCallId, path: absolutePath, oldText, newText });
				}
			}
			return result;
		},
	};
}

export const mutationsToDiffContent: MutationsToDiffContent = (mutations) => {
	if (mutations.length === 0) return undefined;
	const changes: DiffChange[] = mutations.map((mutation) =>
		mutation.oldText === null
			? { operation: "add", path: mutation.path, fileType: "text" }
			: { operation: "modify", path: mutation.path, fileType: "text" },
	);
	const diff: AcpDiff = {
		changes,
		patch: { format: "git_patch", text: mutations.map((mutation) => filePatch(mutation)).join("") },
	};
	const content: ToolCallContent = { type: "diff", ...diff };
	return content;
};

/** Git-style patch block for one mutated file. */
function filePatch(mutation: FileMutation): string {
	const rel = toGitPath(mutation.path);
	const oldText = mutation.oldText ?? "";
	const oldName = mutation.oldText === null ? "/dev/null" : `a/${rel}`;
	const body = Diff.createTwoFilesPatch(oldName, `b/${rel}`, oldText, mutation.newText, undefined, undefined, {
		context: 3,
	});
	// createTwoFilesPatch emits `---`/`+++` file headers but no `diff --git`
	// line; git_patch consumers expect the full git header.
	return `diff --git a/${rel} b/${rel}\n${body}`;
}

/** Absolute path to forward-slash git path (no leading slash: `a/<rel>`). */
function toGitPath(absolutePath: string): string {
	return absolutePath
		.replace(/^[A-Za-z]:/, "")
		.split(/[/\\]+/)
		.filter((part) => part !== "" && part !== ".")
		.join("/");
}
