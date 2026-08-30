# Codex profiles

Two formats exist depending on your CLI version. Check with `codex --version`, and confirm what actually loaded with `/status` inside a session rather than trusting the file.

## Codex 0.134.0 and later — one file per profile

`--profile` no longer reads `[profiles.<name>]` from `config.toml`, and the top-level `profile = "..."` selector is gone. Each profile is its own file in `~/.codex/`, layered above your base config, so it only needs the keys that differ.

**`~/.codex/architect.config.toml`**
```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
approval_policy = "on-request"
sandbox_mode = "read-only"
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
model_reasoning_effort = "low"
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
model_reasoning_effort = "xhigh"
sandbox_mode = "read-only"

[profiles.builder]
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"

[profiles.quick]
model = "gpt-5.3-codex-spark"
model_reasoning_effort = "low"
```

## Notes

- `architect` is deliberately `read-only`. The design and redteam stages have no business touching the working tree, and the sandbox is a cheaper guarantee than an instruction.
- `xhigh` is expensive. It earns its cost on `/design` and on stateful debugging, and nowhere else. `max` is Sol-only and worth reserving for a design you have already failed to get right twice.
- Alt+`,` and Alt+`.` adjust effort mid-session. Profiles cannot be switched mid-session.
- Model IDs churn. Verify against current Codex model docs before committing these to a repo.

## Project-level config

`.codex/config.toml` at the repo root is committed and overrides user config. Use it to pin the sandbox and approval policy for a given project, not the model — model choice is per-stage, not per-repo.

```toml
# .codex/config.toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```
