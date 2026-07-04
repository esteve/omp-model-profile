# Model Profiles

Use when the user asks to create, switch, inspect, or manage omp model profiles, or wants different models for roles like Architect (`plan`), Default, Subtask (`task`), Designer, Commit, Vision, Slow, or Smol.

## Behavior

- Prefer `/model-profile` menus when UI is available. Do not ask the user to type model IDs manually unless they provide an explicit profile JSON.
- Use `/model-profile list` to inspect existing profiles.
- Use `/model-profile show <name>` to inspect role assignments and availability.
- Use `/model-profile switch <name>` to activate a profile; use `/model-profile switch none` to clear the project override. `/model-profile use` remains a compatibility alias.
- Use `/model-profile create <name>` to create a profile from model pickers.
- Use `/model-profile save <name>` to snapshot the current effective role configuration.
- Use `/model-profile edit <name>` to change one role's model.
- When picking a thinking level for the `default` role, `auto` is available — it keeps per-prompt adaptive thinking (low–xhigh) and is applied to the live session on activation. Concrete levels (`minimal`…`xhigh`, `off`) work for any role.
- Writes default to the project file (`.omp/model-profiles.json`). Add `--scope global` (or `--global`; `--user` is still accepted) for global profiles in `~/.omp/agent/model-profiles.json`.

## Roles

Built-in roles only in v1:

- `default` — current/default model
- `smol` — fast model
- `slow` — thinking model
- `vision` — image-capable model
- `plan` — Architect
- `designer` — design specialist
- `commit` — commit message model
- `task` — subtask/subagent default

Custom roles are out of scope for this extension version.
