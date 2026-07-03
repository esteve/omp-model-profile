/**
 * Runtime application of a profile against the live session.
 *
 * All host state is reached through the injected `pi` / `ctx` objects:
 * - `pi.pi.settings` is the same singleton every role consumer reads, so
 *   overriding `modelRoles` / `cycleOrder` / `task.agentModelOverrides` reaches
 *   task subagents, the architect picker, Ctrl+P cycling, commit, and eval.
 * - `pi.setModel` is the only thing that moves the *live* model; role overrides
 *   alone do not.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	mapProfileToOverrides,
	resolveCanonicalFromRegistry,
	resolveCompatibleModelString,
	splitThinkingSuffix,
	toConfiguredThinkingLevel,
} from "./apply";
import type { ModelProfile } from "./types";

const STATUS_KEY = "model-profile";
const ROLES_KEY = "modelRoles" as const;
const CYCLE_KEY = "cycleOrder" as const;
const TASK_KEY = "task.agentModelOverrides" as const;

/**
 * Surface the active profile in the host UI. Prefers the powerline status-line
 * segment (`setStatusSegment`) so the indicator renders inside the editor top
 * border; falls back to the separate hook-status line (`setStatus`) on hosts
 * that predate that API. Pass `undefined` to clear.
 */
function setProfileStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	const ui = ctx.ui as typeof ctx.ui & {
		setStatusSegment?: (key: string, text: string | undefined, options?: { side?: "left" | "right" }) => void;
	};
	if (ui.setStatusSegment) ui.setStatusSegment(STATUS_KEY, text);
	else ui.setStatus(STATUS_KEY, text);
}

/** Drop every override this extension manages, returning to base settings. */
function clearOverrides(pi: ExtensionAPI): void {
	const s = pi.pi.settings;
	s.clearOverride(ROLES_KEY);
	s.clearOverride(CYCLE_KEY);
	s.clearOverride(TASK_KEY);
}

/** Resolve a role pattern to a live, available model (canonical fallback). */
function resolveLiveModel(ctx: ExtensionContext, pattern: string) {
	return resolveCompatibleModelString(pattern, ctx.modelRegistry.getAvailable(), id =>
		resolveCanonicalFromRegistry(ctx.modelRegistry, id),
	);
}

/**
 * Apply the `default` role's configured thinking suffix to the live session.
 *
 * The suffix is parsed as a configured selector so `auto` (per-turn adaptive)
 * survives alongside concrete efforts (`:high`) and `:off`. A `default` pattern
 * with no recognised suffix leaves the current selector untouched, preserving
 * whatever the session already has (e.g. `auto`).
 */
function applyDefaultThinking(pi: ExtensionAPI, profile: ModelProfile): void {
	const defaultPattern = profile.modelRoles?.default;
	if (!defaultPattern) return;
	const level = toConfiguredThinkingLevel(splitThinkingSuffix(defaultPattern).suffix);
	// `auto` is accepted by the host's runtime `setThinkingLevel` but absent from
	// its public parameter type; assert to that param type so the extension needs
	// no core change. `ThinkingLevel` is not re-exported, so we derive it.
	if (level) pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
}

/**
 * Apply a profile: clear prior overrides, install the profile's role set, then
 * move the live model to the resolved `default`. Notifies when the default
 * cannot be activated (no API key / unresolved pattern) but still keeps the
 * role overrides — subagents and pickers honour them regardless.
 */
export async function applyProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	name: string,
	profile: ModelProfile,
): Promise<void> {
	const s = pi.pi.settings;
	clearOverrides(pi);

	const overrides = mapProfileToOverrides(profile);
	s.overrideModelRoles(overrides.modelRoles);
	if (overrides.cycleOrder) s.override(CYCLE_KEY, overrides.cycleOrder);
	if (overrides.taskAgentModelOverrides) s.override(TASK_KEY, overrides.taskAgentModelOverrides);

	const defaultPattern = s.getModelRole("default");
	if (defaultPattern) {
		const model = resolveLiveModel(ctx, defaultPattern);
		if (!model) {
			ctx.ui.notify(
				`Profile "${name}" applied; default model "${defaultPattern}" could not be resolved.`,
				"warning",
			);
		} else if (!(await pi.setModel(model))) {
			ctx.ui.notify(
				`Profile "${name}" applied; default model "${defaultPattern}" is unavailable (no API key).`,
				"warning",
			);
		}
	}

	applyDefaultThinking(pi, profile);

	setProfileStatus(ctx, `◈ ${name}`);
}

/**
 * Clear the active profile: drop overrides and revert the live model to the
 * base (non-overridden) default when it resolves; otherwise leave it in place.
 */
export async function clearProfile(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	clearOverrides(pi);

	const basePattern = pi.pi.settings.getModelRole("default");
	if (basePattern) {
		const model = resolveLiveModel(ctx, basePattern);
		if (model) await pi.setModel(model);
	}

	setProfileStatus(ctx, undefined);
}
