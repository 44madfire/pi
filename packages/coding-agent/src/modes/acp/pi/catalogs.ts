/**
 * ACP catalogs: config options (model, thought_level) and usage updates.
 *
 * The session's ModelRuntime snapshot is the source of available models; the
 * session's thinking level plus the current model's reasoning support is the
 * source of available thought levels. Usage comes from the session's context
 * usage estimate and cumulative session stats.
 */

import type {
	SessionConfigOption,
	SessionConfigSelectOption,
	UsageUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { UpdateSink } from "../core/types.ts";

export const MODEL_CONFIG_ID = "model";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

/** Thrown by `applyConfigOption` for an unknown configId or value. The wire adapter maps it to invalidParams. */
export class InvalidConfigOptionError extends Error {
	readonly configId: string;
	readonly value: string;

	constructor(configId: string, value: string) {
		super(`Invalid config option value ${JSON.stringify(value)} for ${JSON.stringify(configId)}`);
		this.name = "InvalidConfigOptionError";
		this.configId = configId;
		this.value = value;
	}
}

function modelValueId(model: Pick<Model<string>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function findModel(session: AgentSession, value: string): Model<string> | undefined {
	const separator = value.indexOf("/");
	if (separator === -1) return undefined;
	const provider = value.slice(0, separator);
	const id = value.slice(separator + 1);
	return session.modelRuntime.getAvailableSnapshot().find((m) => m.provider === provider && m.id === id);
}

function buildModelOption(session: AgentSession): SessionConfigOption {
	const available = session.modelRuntime.getAvailableSnapshot();
	const current = session.model;
	const options: SessionConfigSelectOption[] = available.map((m) => ({
		value: modelValueId(m),
		name: m.name || m.id,
		description: m.provider,
	}));
	return {
		type: "select",
		configId: MODEL_CONFIG_ID,
		name: "Model",
		description: "Model for this session",
		category: "model",
		currentValue: current ? modelValueId(current) : "",
		options,
	};
}

function buildThoughtLevelOption(session: AgentSession): SessionConfigOption {
	const levels = session.getAvailableThinkingLevels();
	return {
		type: "select",
		configId: THOUGHT_LEVEL_CONFIG_ID,
		name: "Thought level",
		description: "Reasoning effort for the current model",
		category: "thought_level",
		currentValue: session.thinkingLevel,
		options: levels.map((level) => ({ value: level, name: level })),
	};
}

/** Full config option list: `model` + `thought_level` selects with current values. */
export function buildConfigOptions(session: AgentSession): SessionConfigOption[] {
	return [buildModelOption(session), buildThoughtLevelOption(session)];
}

/**
 * Apply one config option and return the full updated list.
 *
 * `value` is the raw `SessionConfigValueId` from the v2 `set_config_option`
 * request. Model values are `provider/id`; thought_level values are level
 * names. Changing the model refreshes the thought_level values via
 * `session.setModel`, which also clamps and re-emits the level.
 *
 * @throws InvalidConfigOptionError for an unknown configId or value.
 */
export async function applyConfigOption(
	session: AgentSession,
	configId: string,
	value: string,
): Promise<SessionConfigOption[]> {
	if (configId === MODEL_CONFIG_ID) {
		const model = findModel(session, value);
		if (!model) throw new InvalidConfigOptionError(configId, value);
		await session.setModel(model);
		return buildConfigOptions(session);
	}
	if (configId === THOUGHT_LEVEL_CONFIG_ID) {
		const levels = session.getAvailableThinkingLevels();
		if (!levels.includes(value as ThinkingLevel)) throw new InvalidConfigOptionError(configId, value);
		session.setThinkingLevel(value as ThinkingLevel);
		return buildConfigOptions(session);
	}
	throw new InvalidConfigOptionError(configId, value);
}

/**
 * Emit `config_option_update` with the full list whenever the model or
 * thinking level changes, including changes made by extensions.
 *
 * `setThinkingLevel` emits `thinking_level_changed` on the session bus, but
 * `setModel`/`cycleModel` emit `model_select` on the extension bus only —
 * there is no public API to subscribe to that bus from outside. So the
 * watcher re-checks a snapshot key on every session event (the same
 * read-fresh-state approach the TUI footer uses) and emits only on change.
 *
 * Caveat: a model switch that keeps the same thinking level emits no session
 * event at all, so its update waits for the next session event (e.g. the
 * next prompt's `message_start`). ACP-driven switches are unaffected:
 * `applyConfigOption` returns the fresh list synchronously.
 */
export function watchConfigOptions(session: AgentSession, sink: UpdateSink): () => void {
	let lastKey = configSnapshotKey(session);
	return session.subscribe(() => {
		const key = configSnapshotKey(session);
		if (key === lastKey) return;
		lastKey = key;
		sink({ sessionUpdate: "config_option_update", configOptions: buildConfigOptions(session) });
	});
}

function configSnapshotKey(session: AgentSession): string {
	const model = session.model;
	const available = session.modelRuntime.getAvailableSnapshot();
	const thought = session.getAvailableThinkingLevels().join(",");
	return `${model ? modelValueId(model) : ""}\0${session.thinkingLevel}\0${thought}\0${available.map(modelValueId).join(",")}`;
}

/**
 * v2 `usage_update` payload from the session's context estimate and stats, or
 * undefined when the context size is unknown (no model or no context window).
 * Faux providers report zero cost, so `cost` is omitted when the total is 0.
 */
export function buildUsageUpdate(session: AgentSession): UsageUpdate | undefined {
	const usage = session.getContextUsage();
	if (!usage) return undefined;
	const stats = session.getSessionStats();
	const used = usage.tokens ?? 0;
	const payload: UsageUpdate = {
		used,
		size: usage.contextWindow,
	};
	if (stats.cost > 0) {
		payload.cost = { amount: stats.cost, currency: "USD" };
	}
	return payload;
}
