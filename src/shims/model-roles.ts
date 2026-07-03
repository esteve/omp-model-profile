/**
 * Backing module for `@oh-my-pi/pi-coding-agent/config/model-roles`, resolved
 * via this plugin's own tsconfig `paths` mapping.
 *
 * The real subpath export ships in the omp host starting at v15.10.11. When
 * this plugin runs *inside* omp, the host's own resolution provides the real
 * module and this shim is never consulted. The `paths` mapping is consulted
 * by both `tsgo` (the plugin's typecheck) and Bun (which honors tsconfig
 * `paths` at runtime) — so this file backs *both* the plugin's own
 * typecheck and the `bun test` runtime, letting the plugin be developed and
 * tested without depending on the host's `node_modules`.
 */

export type ModelRole =
	| "default"
	| "smol"
	| "slow"
	| "vision"
	| "plan"
	| "designer"
	| "commit"
	| "tiny"
	| "task"
	| "advisor";

export interface RoleInfo {
	tag?: string;
	name: string;
	color?: string;
	hidden?: boolean;
}

export const MODEL_ROLE_IDS: readonly ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"designer",
	"commit",
	"tiny",
	"task",
	"advisor",
];

const MODEL_ROLES: Record<ModelRole, RoleInfo> = {
	default: { tag: "DEFAULT", name: "Default", color: "success" },
	smol: { tag: "SMOL", name: "Fast", color: "warning" },
	slow: { tag: "SLOW", name: "Thinking", color: "accent" },
	vision: { tag: "VISION", name: "Vision", color: "error" },
	plan: { tag: "PLAN", name: "Architect", color: "muted" },
	designer: { tag: "DESIGNER", name: "Designer", color: "muted" },
	commit: { tag: "COMMIT", name: "Commit", color: "dim" },
	tiny: { tag: "TINY", name: "Tiny", color: "dim" },
	task: { tag: "TASK", name: "Subtask", color: "muted" },
	advisor: { tag: "ADVISOR", name: "Advisor", color: "accent" },
};

export function getRoleInfo(role: string, settings: unknown): RoleInfo {
	const builtIn = role in MODEL_ROLES ? MODEL_ROLES[role as ModelRole] : undefined;
	const configured = (
		settings as { get?: (key: string) => Record<string, { name?: string; color?: string; hidden?: boolean }> }
	)?.get?.("modelTags")?.[role];

	if (configured) {
		return {
			tag: builtIn?.tag,
			name: configured.name || builtIn?.name || role,
			color: configured.color || builtIn?.color,
			hidden: configured.hidden ?? builtIn?.hidden,
		};
	}

	if (builtIn) return builtIn;

	return { name: role, color: "muted" };
}
