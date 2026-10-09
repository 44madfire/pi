import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import type { CoreUpdate } from "../../src/modes/acp/core/types.ts";
import {
	applyConfigOption,
	buildConfigOptions,
	buildUsageUpdate,
	InvalidConfigOptionError,
	watchConfigOptions,
} from "../../src/modes/acp/pi/catalogs.ts";
import { buildAvailableCommands } from "../../src/modes/acp/pi/commands.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { isUpdate } from "./updates.ts";

/** Flat values of a select config option. Throws for boolean/custom options or grouped options. */
function selectOptionValues(option: SessionConfigOption): string[] {
	if (option.type !== "select") throw new Error(`expected select, got ${option.type}`);
	if (!("options" in option)) throw new Error("expected select options");
	const options: unknown = option.options;
	if (!Array.isArray(options)) throw new Error("expected select options array");
	return options.map((entry: unknown) => {
		if (typeof entry !== "object" || entry === null || !("value" in entry)) {
			throw new Error("expected flat select option");
		}
		const value: unknown = entry.value;
		if (typeof value !== "string") throw new Error("expected string option value");
		return value;
	});
}

describe("ACP catalogs", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds model and thought_level selects", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);

		const options = buildConfigOptions(harness.session);

		expect(options.map((o) => o.configId)).toEqual(["model", "thought_level"]);
		const [model, thought] = options;
		expect(model.type).toBe("select");
		expect(model.category).toBe("model");
		if (model.type !== "select") throw new Error("expected select");
		expect(model.currentValue).toBe("faux/faux-1");
		expect(model.options).toEqual([
			{ value: "faux/faux-1", name: "One", description: "faux" },
			{ value: "faux/faux-2", name: "Two", description: "faux" },
		]);
		expect(thought.type).toBe("select");
		expect(thought.category).toBe("thought_level");
		if (thought.type !== "select") throw new Error("expected select");
		// Reasoning model: off..high (xhigh/max need explicit thinkingLevelMap entries).
		expect(thought.currentValue).toBe("off");
		expect(selectOptionValues(thought)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("applyConfigOption switches model and refreshes thought_level values", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");

		const options = await applyConfigOption(harness.session, "model", "faux/faux-2");

		expect(harness.session.model?.id).toBe("faux-2");
		const [model, thought] = options;
		if (model.type !== "select" || thought.type !== "select") throw new Error("expected selects");
		expect(model.currentValue).toBe("faux/faux-2");
		// Non-reasoning model: only "off"; setModel clamps the inherited "high".
		expect(selectOptionValues(thought)).toEqual(["off"]);
		expect(thought.currentValue).toBe("off");
		expect(harness.session.thinkingLevel).toBe("off");
	});

	it("applyConfigOption sets thought_level and rejects invalid values", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);

		const options = await applyConfigOption(harness.session, "thought_level", "low");
		const thought = options[1];
		if (thought.type !== "select") throw new Error("expected select");
		expect(thought.currentValue).toBe("low");
		expect(harness.session.thinkingLevel).toBe("low");

		await expect(applyConfigOption(harness.session, "thought_level", "ultra")).rejects.toBeInstanceOf(
			InvalidConfigOptionError,
		);
		await expect(applyConfigOption(harness.session, "model", "faux/nope")).rejects.toBeInstanceOf(
			InvalidConfigOptionError,
		);
		await expect(applyConfigOption(harness.session, "mode", "x")).rejects.toBeInstanceOf(InvalidConfigOptionError);
	});

	it("watchConfigOptions emits on external setModel", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");
		const updates: CoreUpdate[] = [];
		const unwatch = watchConfigOptions(harness.session, (u) => updates.push(u));
		try {
			// Reasoning -> non-reasoning clamps high -> off, emitting
			// thinking_level_changed; the snapshot key also catches the model.
			await harness.session.setModel(harness.getModel("faux-2")!);
		} finally {
			unwatch();
		}

		expect(updates.length).toBeGreaterThanOrEqual(1);
		const last = updates[updates.length - 1]!;
		expect(last.sessionUpdate).toBe("config_option_update");
		if (!isUpdate(last, "config_option_update")) throw new Error("expected config_option_update");
		const [model, thought] = last.configOptions;
		if (model?.type !== "select" || thought?.type !== "select") throw new Error("expected selects");
		expect(model.currentValue).toBe("faux/faux-2");
		expect(selectOptionValues(thought)).toEqual(["off"]);
	});

	it("watchConfigOptions emits on extension-driven setThinkingLevel and stops after unsubscribe", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);
		const updates: CoreUpdate[] = [];
		const unwatch = watchConfigOptions(harness.session, (u) => updates.push(u));

		harness.session.setThinkingLevel("medium");
		expect(updates).toHaveLength(1);

		unwatch();
		harness.session.setThinkingLevel("low");
		expect(updates).toHaveLength(1);
	});

	it("lists executable commands from all three sources", async () => {
		const skillDir = join(tmpdir(), `pi-acp-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(skillDir, { recursive: true });
		tempDirs.push(skillDir);
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, "# Ship\n\nShip it.");
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerCommand("deploy", {
					description: "Deploy command",
					handler: async () => {},
				});
			},
		]);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getPrompts: () => ({
				prompts: [
					{
						name: "review",
						description: "Review template",
						argumentHint: "<file>",
						content: "Review this code: $1",
						filePath: "/virtual/review.md",
						sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
							source: "local",
							scope: "temporary",
							origin: "top-level",
						}),
					},
					{
						name: "standup",
						description: "Standup template",
						content: "What did I do today?",
						filePath: "/virtual/standup.md",
						sourceInfo: createSyntheticSourceInfo("/virtual/standup.md", {
							source: "local",
							scope: "temporary",
							origin: "top-level",
						}),
					},
				],
				diagnostics: [],
			}),
			getSkills: () => ({
				skills: [
					{
						name: "ship",
						description: "Ship skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: skillDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: skillDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		expect(buildAvailableCommands(harness.session)).toEqual([
			{ name: "deploy", description: "Deploy command", input: { type: "text", hint: "arguments" } },
			{ name: "review", description: "Review template", input: { type: "text", hint: "<file>" } },
			{ name: "standup", description: "Standup template", input: null },
			{ name: "skill:ship", description: "Ship skill", input: { type: "text", hint: "arguments" } },
		]);
	});

	it("executes each listed command via prompt", async () => {
		const skillDir = join(tmpdir(), `pi-acp-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(skillDir, { recursive: true });
		tempDirs.push(skillDir);
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, "# Ship\n\nShip it.");
		const commandRuns: string[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerCommand("deploy", {
					description: "Deploy command",
					handler: async (args) => {
						commandRuns.push(args);
					},
				});
			},
		]);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getPrompts: () => ({
				prompts: [
					{
						name: "review",
						description: "Review template",
						content: "Review this code: $1",
						filePath: "/virtual/review.md",
						sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
							source: "local",
							scope: "temporary",
							origin: "top-level",
						}),
					},
				],
				diagnostics: [],
			}),
			getSkills: () => ({
				skills: [
					{
						name: "ship",
						description: "Ship skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: skillDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: skillDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		// Extension command: handled without consuming a provider response.
		harness.setResponses([fauxAssistantMessage("should stay queued")]);
		await harness.session.prompt("/deploy production");
		expect(commandRuns).toEqual(["production"]);
		expect(harness.getPendingResponseCount()).toBe(1);

		// Prompt template: expands $1 before sending.
		let expanded = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((m) => m.role === "user");
				expanded = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("/review src/index.ts");
		expect(expanded).toBe("Review this code: src/index.ts");

		// Skill: inlines the skill body plus args.
		harness.setResponses([
			(context) => {
				const users = context.messages.filter((m) => m.role === "user");
				const user = users[users.length - 1];
				expanded = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("/skill:ship v2");
		expect(expanded).toContain('<skill name="ship"');
		expect(expanded).toContain("Ship it.");
		expect(expanded).toContain("v2");
	});

	it("an unlisted builtin name is not executed by prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(buildAvailableCommands(harness.session).map((c) => c.name)).not.toContain("model");

		let sent = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((m) => m.role === "user");
				sent = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("/model faux/faux-1");
		// No extension/template/skill claims it: literal text reaches the model.
		expect(sent).toBe("/model faux/faux-1");
	});

	it("buildUsageUpdate reflects context and cost after a turn", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", reasoning: true, contextWindow: 100000 }],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello there")]);
		await harness.session.prompt("hi");

		const update = buildUsageUpdate(harness.session);
		expect(update).toBeDefined();
		expect(update!.size).toBe(100000);
		expect(update!.used).toBeGreaterThan(0);
		// Faux provider costs nothing.
		expect(update!.cost).toBeUndefined();
	});
});
