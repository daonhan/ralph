# @daonhan/ralph

CLI for **[Ralph](https://github.com/daonhan/ralph)** — a harness that drives the
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) CLI against a target
repository in an iterating implementer → reviewer loop, running `claude` directly on the host.
Docker is not required.

Exposes two bin entries (thin wrappers over
**[`@daonhan/ralph-core`](https://www.npmjs.com/package/@daonhan/ralph-core)**):

- **`ralph-afk`** — plan/PRD-driven loop. Iterates until the agent emits `<promise>NO MORE TASKS</promise>`.
- **`ralph-ghafk`** — GitHub-issue-driven loop. Pulls open issues and lets the agent pick the next task.

> **Security:** Ralph runs Claude with `--permission-mode bypassPermissions`. The default
> `RALPH_RUNNER=sandbox` uses Claude Code's native OS sandbox (Seatbelt on macOS) to confine
> writes to the workspace. Point it only at repositories and prompts you trust. See
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
ralph-afk --help                  # flags, env vars
ralph-afk --print-config          # diagnose workspace / runner / sandbox config
```

Requires an authenticated Claude Code login (and `gh` for `ralph-ghafk`). First-run
setup, per-OS notes, and the full flag/env reference are in the
**[main README](https://github.com/daonhan/ralph#readme)** and
**[QUICKSTART](https://github.com/daonhan/ralph/blob/main/QUICKSTART.md)**.

## License

[MIT](https://github.com/daonhan/ralph/blob/main/LICENSE) © Paul Nguyen.
