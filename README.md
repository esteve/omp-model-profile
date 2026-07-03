# omp Model Profiles

Named model-role profiles for omp. A profile sets different models for the built-in roles (`default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `task`) and switches them all at once with `/model-profile`.

## Install

Once published to npm, anyone can install it with one command:

```sh
omp plugin install omp-model-profile
```

This downloads the package into `~/.omp/plugins/`, where omp discovers its
`/model-profile` command, `session_start` hook, and bundled skills. Verify with
`omp plugin list` / `omp plugin doctor`, then reload a running session with
`/reload-plugins`.

### Direct from GitHub (no npm publish required)

Because the package lives at the repo root, omp can install it straight from git:

```sh
omp plugin install github:tlarevo/omp-model-profile
```

### Via an omp marketplace (in-app discovery)

Marketplace catalogs are now discovered from **`.omp-plugin/marketplace.json`**
first, with **`.claude-plugin/marketplace.json`** still supported as a fallback
for older/shared catalogs. A minimal catalog pointing at this repo looks like:

```json
{
  "name": "my-omp-plugins",
  "owner": { "name": "tlarevo" },
  "plugins": [
    {
      "name": "model-profile",
      "description": "Named model-role profiles for omp",
      "source": { "source": "github", "repo": "tlarevo/omp-model-profile" }
    }
  ]
}
```

From inside a running omp session, add the marketplace and browse/install via
the built-in slash commands:

```text
/marketplace add <owner/repo>
/marketplace
/marketplace install model-profile@my-omp-plugins
```

If you prefer the shell/CLI instead of the in-app browser, the equivalent flow
is:

```sh
omp plugin marketplace add <owner/repo>
omp plugin install model-profile@my-omp-plugins
```

You can also browse explicitly with `/marketplace discover` (or `omp plugin
discover <marketplace>` in the CLI).

> Marketplace catalogs still cannot install plugins from typed `npm` sources.
> Use a git-based source in the catalog, or install the npm package directly
> with `omp plugin install omp-model-profile`.

### Local development

Clone this repo, then symlink it so edits go live with `/reload-plugins`:

```sh
omp plugin link path/to/omp-model-profile
```

Or load it ad-hoc for a single session without installing:

```sh
omp -e path/to/omp-model-profile/src/index.ts
```

## Commands

```text
/model-profile                 Open the menu (interactive)
/model-profile use <name|none> Activate or clear a profile
/model-profile show <name>     Inspect a profile
/model-profile create <name>   Build a profile with model pickers
/model-profile generate [name] <prompt>   Generate a profile with AI
/model-profile save <name>     Snapshot current role settings
/model-profile edit <name>     Change one role's model
/model-profile delete <name>   Remove a profile
/model-profile list            List all profiles
```

Writes default to the project file. Add `--scope user`, `--user`, or `--project` to target a scope.

### Generate with AI

`/model-profile generate [name] <prompt>` turns a description ("a fast, cheap
profile preferring OpenAI models") into a profile. The name is optional — skip
it and the model proposes one along with the profile. It asks an LLM — using your
current session model — to assign a model to each role, then validates every
pick against your available models before saving and showing a preview you can
refine or activate. The request is a one-shot completion that never touches the
chat transcript. Requires an authenticated model; needs `@oh-my-pi/pi-ai`
(installed alongside `@oh-my-pi/pi-coding-agent`).

The model picker used by `create`/`edit`/`generate` supports provider tabs
(`←/→`) and type-to-filter, so you can jump to a provider and narrow quickly —
useful when the same model id is served by several providers.

## Storage

Project profiles live at:

```text
<cwd>/.omp/model-profiles.json
```

User profiles live at:

```text
~/.omp/agent/model-profiles.json
```

Effective profiles are merged as `{ ...user.profiles, ...project.profiles }`, so project profiles win by name. The active pointer prefers the project file, then the user file.

## JSON format

```json
{
  "active": "deep-review",
  "profiles": {
    "deep-review": {
      "description": "High-quality planning/review",
      "modelRoles": {
        "default": "anthropic/claude-sonnet-4-5:high",
        "plan": "anthropic/claude-opus-4-5:high",
        "task": "openai-codex/gpt-5-codex:medium",
        "commit": "anthropic/claude-haiku-4-5:minimal"
      },
      "cycleOrder": ["smol", "default", "slow"],
      "taskAgentModelOverrides": {
        "reviewer": "pi/slow"
      }
    }
  }
}
```

Thinking suffixes (`:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:off`, `:auto`) are preserved in role settings. On activation, the **`default`** role's suffix is applied to the live session — including `:auto`, which keeps per-prompt adaptive thinking (low–xhigh). A `default` with no suffix leaves the current thinking selector untouched. Other roles keep their concrete suffixes for subagents/pickers via omp's resolver; `auto` is offered only for the `default` role since it is a session-level selector.

## Compatibility

Requires omp host `@oh-my-pi/pi-coding-agent >= 15.10.11` (for the
`config/model-roles` subpath export) and `@oh-my-pi/pi-ai >= 15`.

Last verified against omp **v16.3.4** (2026-07-03) via `bun run check:omp-head`,
which typechecks this plugin against the current omp source.

## Releasing

CI (`.github/workflows/ci.yml`) runs `bun run check` + `bun test` on every push to
`main` and every PR. Releases are tag-driven:

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [x.y.z]` heading and commit.
2. Refresh the "Last verified against" line in the Compatibility section (run `bun run check:omp-head` first).
3. `npm version <patch|minor|major>` — bumps `package.json` and creates the `vX.Y.Z` commit + tag.
4. `git push --follow-tags`.

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which re-runs check/tests,
verifies the tag matches `package.json`, and publishes to npm. Publishing uses
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) — no
`NPM_TOKEN` secret required. The package must have a Trusted Publisher configured
on npmjs.com (package Settings → Trusted publishing) naming this repository,
`release.yml`, and the `npm publish` action; npm auto-generates provenance for
trusted-publisher releases.