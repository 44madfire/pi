/**
 * ACP available commands: the slash commands a headless session executes via
 * `session.prompt("/name args")`.
 *
 * Same three sources RPC `get_commands` uses, in the same order:
 * extension commands, prompt templates, skills.
 *
 * Executability in a headless session (`AgentSession.prompt`):
 * - Extension commands: `_tryExecuteExtensionCommand` matches the text after
 *   `/` up to the first space against `extensionRunner.getCommand(name)`,
 *   which resolves by `invocationName`. Every registered command is
 *   executable, so all are listed by invocation name.
 * - Prompt templates: `expandPromptTemplate` matches `/name ...` against
 *   template names and substitutes `$1`/`$@`/`${N:-default}` placeholders.
 *   All templates expand, so all are listed.
 * - Skills: `_expandSkillCommand` matches `/skill:name ...` and inlines the
 *   skill file body plus args. All skills expand, so all are listed under
 *   the `skill:name` invocation form.
 *
 * Excluded:
 * - Built-in interactive commands (`BUILTIN_SLASH_COMMANDS`: /model,
 *   /thinking, /tree, ...) — handled by the TUI layer, unknown to
 *   `AgentSession.prompt`; in a headless session `/model x` would reach
 *   the LLM as literal text.
 * - An extension command whose `invocationName` collides with a prompt
 *   template name: extension dispatch runs first and shadows the template,
 *   so the template form is unreachable and omitted. (Same shadowing the
 *   interactive autocomplete applies in reverse for built-ins; here the
 *   extension wins because `prompt()` tries it first.)
 * - A skill named such that `skill:name` collides with an extension command
 *   or template name: as above, extension dispatch and template expansion
 *   run before skill expansion only in the sense that `/skill:name` is a
 *   distinct prefix — in practice a collision requires an extension command
 *   literally named `skill:name`, which the dedupe below also drops.
 */
import type { AvailableCommand } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentSession } from "../../../core/agent-session.ts";

/** Commands `session.prompt("/name args")` executes. Static per session in P1 (no watcher). */
export function buildAvailableCommands(session: AgentSession): AvailableCommand[] {
	const commands: AvailableCommand[] = [];
	const seen = new Set<string>();

	// Extension commands first: prompt() dispatches them before expansion,
	// so on a name collision the extension form wins and later forms are dead.
	for (const command of session.extensionRunner.getRegisteredCommands()) {
		if (seen.has(command.invocationName)) continue;
		seen.add(command.invocationName);
		commands.push({
			name: command.invocationName,
			description: command.description ?? "",
			input: { type: "text", hint: "arguments" },
		});
	}

	for (const template of session.promptTemplates) {
		if (seen.has(template.name)) continue;
		seen.add(template.name);
		commands.push({
			name: template.name,
			description: template.description,
			input: templateTakesArgs(template.content)
				? { type: "text", hint: template.argumentHint ?? "arguments" }
				: null,
		});
	}

	for (const skill of session.resourceLoader.getSkills().skills) {
		const name = `skill:${skill.name}`;
		if (seen.has(name)) continue;
		seen.add(name);
		commands.push({
			name,
			description: skill.description,
			input: { type: "text", hint: "arguments" },
		});
	}

	return commands;
}

/** True when template content references caller-supplied arguments. Mirrors `substituteArgs` placeholders. */
function templateTakesArgs(content: string): boolean {
	return /\$\{(\d+|ARGUMENTS|@):-[^}]*\}|\$\{@:\d+(?::\d+)?\}|\$(ARGUMENTS|@|\d+)/.test(content);
}
