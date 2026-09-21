# Codex profiles

Two formats exist depending on your CLI version. Check with `codex --version`, and confirm what actually loaded with `/status` inside a session rather than trusting the file.

## Codex 0.134.0 and later — one file per profile

`--profile` no longer reads `[profiles.<name>]` from `config.toml`, and the top-level `profile = "..."` selector is gone. Each profile is its own file in `~/.codex/`, layered above your base config, so it only needs the keys that differ.

**`~/.codex/architect.config.toml`**
```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "read-only"
```

**`~/.codex/author.config.toml`**
```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
```

**`~/.codex/builder.config.toml`**
```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
```

**`~/.codex/quick.config.toml`**
```toml
model = "gpt-5.3-codex-spark"
model_reasoning_effort = "medium"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
```

## Before 0.134.0 — sections in `~/.codex/config.toml`

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.architect]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
sandbox_mode = "read-only"

[profiles.author]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"

[profiles.builder]
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"

[profiles.quick]
model = "gpt-5.3-codex-spark"
model_reasoning_effort = "medium"
```

## Notes

- `architect` is deliberately `read-only`. It backs `/redteam` (and `/brief`, which also writes nothing) — stages that have no business touching the working tree, where the sandbox is a cheaper guarantee than an instruction.
- `author` is the same model and effort as `architect`, but `workspace-write`. It backs `/interview`, `/design`, `/spec`, `/plan`, and `/align` — deep-reasoning-tier commands whose normal work is writing to `design/`. Splitting it from `architect` keeps the read-only guarantee meaningful for `/redteam` instead of blocking every other deep-reasoning command from doing its job.
- `xhigh` is expensive and is not either profile's default — see `AGENTS.shared.md`, *Model, effort, and review budget*: "`xhigh` is for one question, not one pipeline." Reach for it with `-Effort xhigh` on a single ambiguous question, not as a phase-wide default. `max` is Sol-only and worth reserving for a design you have already failed to get right twice.
- Alt+`,` and Alt+`.` adjust effort mid-session. Profiles cannot be switched mid-session.
- Model IDs churn. Verify against current Codex model docs before committing these to a repo.

## Output and context budget

`AGENTS.shared.md`, *Output discipline* is the rule, and it binds every vendor. These base-config keys are how Codex lets you back it up. Checked against codex-cli 0.153.4's `config.schema.json`. They are **recommended, not enforced**: `tools/Invoke-CodexCommand.ps1` does not pass them, because they are preferences about your whole machine rather than a tier, and a launcher that overrode them would overwrite choices this kit has never owned.

| Key | What it controls | Where it can live | Guidance |
|---|---|---|---|
| `model_verbosity` | Length of the visible reply (`low`/`medium`/`high`) | base or `[profiles.<name>]` | `low` suits the rule. It shortens the reply, not the reasoning. |
| `model_reasoning_summary` | Reasoning summaries shown in the session (`auto`/`concise`/`detailed`/`none`) | base or profile | `none` removes output nobody acts on. It does not lower effort. |
| `plan_mode_reasoning_effort` | Effort used in plan mode | base or profile | Set it in each profile file to the profile's own effort. A base value below `high` quietly under-powers `architect` and `author` in plan mode. |
| `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope` | When the session compacts, and whether the fixed prefix counts (`total`/`body_after_prefix`) | base only | Optional. A compaction during `/slice` is still a sizing failure (`AGENTS.shared.md`, *Session boundaries*); an earlier limit makes that visible sooner and changes nothing else. |
| `tool_output_token_limit` | Tokens of one tool result kept in context | base only | If set, keep gate output in a log file. A cap that cuts off a failure's diagnostics breaks *Output discipline*, not just the gate. |
| `[agents] default_subagent_reasoning_effort` | Effort of a subagent that does not name one | base only | `medium` is the Implementation tier. A deep-reasoning subagent must name its effort. |
| `[agents] max_concurrent_threads_per_session` | Parallel subagents | base only | No value is recommended. None has been measured here. |

With a profile file (0.134.0 and later), any of these can go in `~/.codex/<name>.config.toml`, including the base-only keys, because that file layers over the whole base config.

**`project_doc_max_bytes` is not on this list — it is enforced, not recommended.** Codex 0.153.4 defaults it to 32,768 bytes (`codex-rs/config/defaults.toml`) and truncates project-doc content past that cap silently — a `tracing::warn!` only, nothing surfaced in the session (`codex-rs/core/src/agents_md.rs`). This repository's own `AGENTS.md` was 49,761 bytes before its shared part moved to `AGENTS.shared.md`, so the default cap truncated it partway through on every unpatched invocation — and a truncated *Source of truth* is the one part of the contract Codex would then never see. The split put this repository's project doc back under the cap, which removes today's instance and not the hazard: a project `AGENTS.md` grows past 32,768 bytes again without anything saying so. `tools/Invoke-CodexCommand.ps1` passes `-c project_doc_max_bytes=<n>` on every `codex` invocation it starts, `<n>` computed fresh per launch as the sum of whichever project-doc file (`AGENTS.override.md` first, else `AGENTS.md`) is present in each directory from the discovered project root down to the launch directory — mirroring Codex's own discovery order and shared, cumulative budget so the value tracks the files' actual sizes instead of a number someone has to remember to update. Running plain `codex` (or `codex --profile <name>`) outside this launcher still needs the override set by hand — in `~/.codex/config.toml` or a profile file — sized to cover the project doc's actual byte count; `wc -c AGENTS.md` reports it.

**Tool surface.** Each `[mcp_servers.<name>]` entry takes `enabled`, `enabled_tools`, and `disabled_tools`. Whether Codex sends every enabled server's tool definitions on every turn is **not verified**: the schema doesn't say and no documentation states it. Disabling servers you don't use during coding is harmless, but nothing here measures what it saves.

## Project-level config

`.codex/config.toml` at the repo root is committed and overrides user config. Use it to pin the sandbox and approval policy for a given project, not the model — model choice is per-stage, not per-repo.

```toml
# .codex/config.toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```
