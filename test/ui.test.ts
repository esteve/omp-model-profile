import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getRoleInfo, MODEL_ROLE_IDS } from "../src/shims/model-roles";
import { pickModel, pickWriteScope, slugifyName } from "../src/ui";
import { testModel } from "./fixtures";

type SelectOptionInput = string | { label: string; description?: string };
interface SelectDialog {
	onLeft?: () => void;
	onRight?: () => void;
	helpText?: string;
}
interface SelectCall {
	title: string;
	options: SelectOptionInput[];
	dialog?: SelectDialog;
}
type ScriptStep = { move: "left" | "right" } | { pick: string } | { cancel: true };

/** Build a fake ExtensionContext whose `ui.select` replays a scripted sequence. */
function makeCtx(script: ScriptStep[]): { ctx: ExtensionContext; calls: SelectCall[] } {
	const calls: SelectCall[] = [];
	let step = 0;
	const select = async (title: string, options: SelectOptionInput[], dialog?: SelectDialog) => {
		calls.push({ title, options, dialog });
		const action = script[step++];
		if (!action) return undefined; // out of script → treated as cancel
		if ("move" in action) {
			if (action.move === "left") dialog?.onLeft?.();
			else dialog?.onRight?.();
			return undefined;
		}
		if ("cancel" in action) return undefined;
		return action.pick;
	};
	const ctx = { ui: { select, notify: () => {} } } as unknown as ExtensionContext;
	return { ctx, calls };
}

const opus = testModel("anthropic", "opus");
const haiku = testModel("anthropic", "haiku");
const gpt = testModel("openai", "gpt");
const qwen = testModel("alibaba", "qwen");
const multi = [opus, haiku, gpt, qwen];

describe("pickModel provider tabs", () => {
	test("switches provider tabs with arrows and filters to that provider", async () => {
		// providers sorted: [All, alibaba, anthropic, openai]; right x2 → anthropic.
		const { ctx, calls } = makeCtx([{ move: "right" }, { move: "right" }, { pick: "anthropic/opus" }]);

		const result = await pickModel(ctx, multi, "Pick model");

		expect(result).toBe(opus);
		expect(calls).toHaveLength(3);
		const anthropicTab = calls[2];
		expect(anthropicTab.title).toContain("anthropic (3/4)");
		const modelLabels = anthropicTab.options
			.map(option => (typeof option === "string" ? option : option.label))
			.filter(label => label !== "— skip —");
		expect(modelLabels).toEqual(["anthropic/haiku", "anthropic/opus"]);
	});

	test("left arrow from the first tab wraps to the last provider", async () => {
		const { ctx, calls } = makeCtx([{ move: "left" }, { pick: "openai/gpt" }]);

		const result = await pickModel(ctx, multi, "Pick model");

		expect(result).toBe(gpt);
		expect(calls[1].title).toContain("openai (4/4)");
		const modelLabels = calls[1].options
			.map(option => (typeof option === "string" ? option : option.label))
			.filter(label => label !== "— skip —");
		expect(modelLabels).toEqual(["openai/gpt"]);
	});

	test("All tab lists every provider's models", async () => {
		const { ctx, calls } = makeCtx([{ pick: "alibaba/qwen" }]);

		const result = await pickModel(ctx, multi, "Pick model");

		expect(result).toBe(qwen);
		const modelLabels = calls[0].options
			.map(option => (typeof option === "string" ? option : option.label))
			.filter(label => label !== "— skip —");
		expect(modelLabels).toEqual(["alibaba/qwen", "anthropic/haiku", "anthropic/opus", "openai/gpt"]);
	});

	test("choosing skip returns skip", async () => {
		const { ctx } = makeCtx([{ pick: "— skip —" }]);
		expect(await pickModel(ctx, multi, "Pick model")).toBe("skip");
	});

	test("escape returns cancel", async () => {
		const { ctx } = makeCtx([{ cancel: true }]);
		expect(await pickModel(ctx, multi, "Pick model")).toBe("cancel");
	});

	test("a single provider offers no tabs", async () => {
		const { ctx, calls } = makeCtx([{ pick: "anthropic/opus" }]);

		const result = await pickModel(ctx, [opus, haiku], "Pick model");

		expect(result).toBe(opus);
		expect(calls[0].dialog?.onLeft).toBeUndefined();
		expect(calls[0].dialog?.onRight).toBeUndefined();
		expect(calls[0].title).toBe("Pick model");
	});

	test("no available models returns skip without prompting", async () => {
		const { ctx, calls } = makeCtx([]);
		expect(await pickModel(ctx, [], "Pick model")).toBe("skip");
		expect(calls).toHaveLength(0);
	});
});

describe("slugifyName", () => {
	test("lowercases and hyphenates free-form names", () => {
		expect(slugifyName("OpenAI Fast")).toBe("openai-fast");
		expect(slugifyName("anthropic/stack")).toBe("anthropic-stack");
		expect(slugifyName("  --weird-- ")).toBe("weird");
	});

	test("keeps already-valid names", () => {
		expect(slugifyName("valid_name.1")).toBe("valid_name.1");
	});

	test("returns undefined when nothing valid survives", () => {
		expect(slugifyName("")).toBeUndefined();
		expect(slugifyName(undefined)).toBeUndefined();
		expect(slugifyName("###")).toBeUndefined();
	});
});

describe("pickWriteScope", () => {
	test("defaults headless flows to project scope", async () => {
		const { ctx, calls } = makeCtx([]);
		(ctx as { hasUI?: boolean }).hasUI = false;
		expect(await pickWriteScope(ctx, undefined, "create")).toBe("project");
		expect(calls).toHaveLength(0);
	});

	test("prompts interactive create flows when no scope is specified", async () => {
		const { ctx, calls } = makeCtx([{ pick: "Global" }]);
		(ctx as { hasUI?: boolean }).hasUI = true;
		expect(await pickWriteScope(ctx, undefined, "create")).toBe("global");
		expect(calls[0]).toMatchObject({
			title: "Where should this profile live?",
			options: [
				{ label: "Project", description: "Stored in .omp/model-profiles.json" },
				{ label: "Global", description: "Stored in ~/.omp/agent/model-profiles.json" },
			],
		});
	});

	test("prompts interactive generate flows when no scope is specified", async () => {
		const { ctx, calls } = makeCtx([{ pick: "Project" }]);
		(ctx as { hasUI?: boolean }).hasUI = true;
		expect(await pickWriteScope(ctx, undefined, "generate")).toBe("project");
		expect(calls[0]?.title).toBe("Where should the generated profile live?");
	});

	test("respects an explicit scope without prompting", async () => {
		const { ctx, calls } = makeCtx([{ pick: "Global" }]);
		(ctx as { hasUI?: boolean }).hasUI = true;
		expect(await pickWriteScope(ctx, "global", "create")).toBe("global");
		expect(calls).toHaveLength(0);
	});
});

describe("model role shim parity", () => {
	test("includes current upstream built-in roles", () => {
		expect(MODEL_ROLE_IDS).toEqual([
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
		]);
		const settings = { get: () => ({}) };
		expect(getRoleInfo("tiny", settings).name).toBe("Tiny");
		expect(getRoleInfo("advisor", settings).name).toBe("Advisor");
	});
});
