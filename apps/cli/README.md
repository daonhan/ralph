# @daonhan/ralph

CLI for **[Ralph](https://github.com/daonhan/ralph)** — a harness that drives Claude Code by
default, or Codex when selected with `--agent codex`, against a target repository in an
iterating implementer → reviewer loop inside an ephemeral Docker sandbox.

Exposes two bin entries (thin wrappers over
**[`@daonhan/ralph-core`](https://www.npmjs.com/package/@daonhan/ralph-core)**):

- **`ralph-afk`** — plan/PRD-driven loop. Iterates until the agent emits `<promise>NO MORE TASKS</promise>`.
- **`ralph-ghafk`** — GitHub-issue-driven loop. Pulls open issues and lets the agent pick the next task.

> **Security:** Ralph runs the selected agent without interactive approval inside the sandbox
> and, by default, bind-mounts the host Docker socket (root-equivalent host access). Point it
> only at repositories and prompts you trust. See
> [SECURITY.md](https://github.com/daonhan/ralph/blob/main/SECURITY.md).

## Install

```bash
npm i -g @daonhan/ralph
```

## Use

```bash
cd /path/to/your/workspace
ralph-afk "<plan-and-prd>" 5      # plan/PRD loop
ralph-ghafk 5                     # GitHub-issue loop
ralph-afk --agent codex "<plan-and-prd>" 5
ralph-ghafk --agent codex 5
ralph-afk --help                  # flags, env vars
ralph-afk --print-config          # diagnose workspace / docker context / image / socket
```

Claude is the default; `RALPH_AGENT=codex` is the fallback when `--agent` is absent. Requires
Docker and a login for the selected provider (and `gh` for `ralph-ghafk`). Codex users should
follow the root README's [file-backed login](https://github.com/daonhan/ralph#codex-login) and
[provider configuration](https://github.com/daonhan/ralph#choose-the-coding-agent) instructions.
First-run setup, per-OS notes, and the full flag/env reference are in the
**[main README](https://github.com/daonhan/ralph#readme)** and
**[QUICKSTART](https://github.com/daonhan/ralph/blob/main/QUICKSTART.md)**.
Read the full [security threat model](https://github.com/daonhan/ralph/blob/main/SECURITY.md)
before running either provider.

## License

[MIT](https://github.com/daonhan/ralph/blob/main/LICENSE) © Paul Nguyen.
