/**
 * Type declarations for `@oh-my-pi/pi-coding-agent/config/model-roles`.
 *
 * The real subpath export ships in the omp host starting at v15.10.11; when
 * this plugin runs *inside* omp, the host's own module resolution provides
 * the real export and this ambient declaration is never consulted. This
 * file exists because this plugin's tsconfig `paths` mapping unconditionally
 * redirects the subpath to the sibling `model-roles.ts` shim for both the
 * plugin's own typecheck (`tsgo`) and its `bun test` runtime (Bun honors
 * tsconfig `paths` too) — it declares the minimal surface that shim and the
 * plugin depend on, without pulling in the host's heavier `config/settings`
 * type graph.
 */
declare module "@oh-my-pi/pi-coding-agent/config/model-roles" {
	type ModelRole =
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

	export const MODEL_ROLE_IDS: readonly ModelRole[];

	export interface RoleInfo {
		tag?: string;
		name: string;
		color?: string;
		hidden?: boolean;
	}

	export function getRoleInfo(role: string, settings: unknown): RoleInfo;
}
