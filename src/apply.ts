/**
 * Pure mapping helpers — no runtime host imports, no I/O.
 * Kept separate so the resolution logic can be unit-tested with plain data.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ModelProfile } from "./types";
export type ProfileModel = NonNullable<ExtensionContext["model"]>;

/**
 * Thinking selectors recognised on a model pattern (`provider/id:high`). Defined
 * locally rather than imported from the host: the live `pi` is the user's
 * installed omp build, whose public `setThinkingLevel` type only names concrete
 * levels even though its runtime accepts `auto`. Keeping the union here lets the
 * extension stay installable against any released omp without a core change.
 */
export type ConfiguredThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "off" | "auto";

/** Lookup table whose keys are exactly {@link ConfiguredThinkingLevel}. */
const THINKING_SUFFIXES: Record<ConfiguredThinkingLevel, true> = {
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	off: true,
	auto: true,
};

/** Normalised override payloads derived from a profile. */
export interface ProfileOverrides {
	/** Truthy, trimmed role → model patterns. */
	modelRoles: Record<string, string>;
	/** Cycle order, or undefined when empty. */
	cycleOrder: string[] | undefined;
	/** Per-subagent overrides, or undefined when empty. */
	taskAgentModelOverrides: Record<string, string> | undefined;
}

/** A model pattern split into its base id and trailing thinking suffix. */
export interface ThinkingSplit {
	/** Model pattern with any recognised thinking suffix removed. */
	base: string;
	/** The recognised thinking suffix (lowercased), or undefined. */
	suffix: string | undefined;
}

/**
 * Split a model pattern into its base id and a trailing `:level` thinking
 * suffix when that suffix names a known effort (`minimal`…`xhigh`), `off`, or
 * `auto`. Leaves ids that legitimately contain a colon (e.g. `llama3:8b`) intact.
 */
export function splitThinkingSuffix(value: string): ThinkingSplit {
	const trimmed = value.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon <= 0) return { base: trimmed, suffix: undefined };
	const suffix = trimmed.slice(colon + 1).toLowerCase();
	return suffix in THINKING_SUFFIXES
		? { base: trimmed.slice(0, colon), suffix }
		: { base: trimmed, suffix: undefined };
}

/** Strip a trailing `:level` thinking suffix; see {@link splitThinkingSuffix}. */
export function stripThinkingSuffix(value: string): string {
	return splitThinkingSuffix(value).base;
}

/**
 * Convert a recognised thinking suffix (see {@link splitThinkingSuffix}) into a
 * {@link ConfiguredThinkingLevel}, or undefined when it is not one.
 *
 * A validated suffix is asserted to the selector type — never derived from a
 * host runtime value — because the live `pi` namespace is the user's installed
 * build, which may predate any newer thinking exports.
 */
export function toConfiguredThinkingLevel(suffix: string | undefined): ConfiguredThinkingLevel | undefined {
	return suffix && suffix in THINKING_SUFFIXES ? (suffix as ConfiguredThinkingLevel) : undefined;
}

/**
 * Resolve a model pattern to a concrete available model.
 *
 * The thinking suffix is dropped first for model matching; `applyProfile` reads
 * the `default` role's suffix separately to set the live session thinking, and
 * role consumers honour concrete suffixes via the host resolver.
 * `provider/id` patterns match exactly against `available`, falling back to a
 * canonical lookup of the id. Bare ids resolve through `resolveCanonical`.
 *
 * `resolveCanonical` is injected so this function stays pure for tests.
 */
export function resolveModelString(
	value: string,
	available: readonly ProfileModel[],
	resolveCanonical?: (canonicalId: string) => ProfileModel | undefined,
): ProfileModel | undefined {
	const base = stripThinkingSuffix(value.trim());
	if (!base) return undefined;
	const slash = base.indexOf("/");
	if (slash > 0) {
		const provider = base.slice(0, slash);
		const id = base.slice(slash + 1);
		const exact = available.find(model => model.provider === provider && model.id === id);
		if (exact) return exact;
		return resolveCanonical?.(id);
	}
	return resolveCanonical?.(base);
}

/**
 * Host-compatible wrapper around {@link resolveModelString}.
 *
 * Older hosts expose `modelRegistry.getAvailable()` but not
 * `resolveCanonicalModel()`. In that case, fall back to a plain id match within
 * the available list rather than throwing.
 */
export function resolveCompatibleModelString(
	value: string,
	available: readonly ProfileModel[],
	resolveCanonical?: (canonicalId: string) => ProfileModel | undefined,
): ProfileModel | undefined {
	return resolveModelString(
		value,
		available,
		canonicalId => resolveCanonical?.(canonicalId) ?? available.find(model => model.id === canonicalId),
	);
}

interface CanonicalResolverLike {
	resolveCanonicalModel: (canonicalId: string, options?: { availableOnly?: boolean }) => ProfileModel | undefined;
}

function hasCanonicalResolver(registry: unknown): registry is CanonicalResolverLike {
	return (
		!!registry &&
		typeof registry === "object" &&
		"resolveCanonicalModel" in registry &&
		typeof registry.resolveCanonicalModel === "function"
	);
}

/** Safely call an optional host canonical resolver when the runtime exposes it. */
export function resolveCanonicalFromRegistry(registry: unknown, canonicalId: string): ProfileModel | undefined {
	if (!hasCanonicalResolver(registry)) return undefined;
	return registry.resolveCanonicalModel(canonicalId, { availableOnly: true });
}

/** Project a profile onto the override payloads, dropping empty fields. */
export function mapProfileToOverrides(profile: ModelProfile): ProfileOverrides {
	const modelRoles: Record<string, string> = {};
	for (const [role, value] of Object.entries(profile.modelRoles ?? {})) {
		if (typeof value !== "string" || !value.trim()) continue;
		// `auto` is a session-only selector the host resolver cannot parse as a
		// role override; strip it here and let applyProfile set it on the live
		// model. Concrete suffixes (`:high`, `:off`) stay — role consumers honour
		// them through the host resolver.
		const split = splitThinkingSuffix(value);
		modelRoles[role] = split.suffix === "auto" ? split.base : value.trim();
	}

	const cycleOrder = profile.cycleOrder?.length ? [...profile.cycleOrder] : undefined;

	const taskAgentModelOverrides =
		profile.taskAgentModelOverrides && Object.keys(profile.taskAgentModelOverrides).length
			? { ...profile.taskAgentModelOverrides }
			: undefined;

	return { modelRoles, cycleOrder, taskAgentModelOverrides };
}
