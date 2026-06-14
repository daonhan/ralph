# Ralph — Quickstart

Zero-to-first-loop for a brand-new user who just wants to run Ralph against their own repo. Depth lives in [`./README.md`](./README.md).

Ralph drives [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) against your repo in an iterating implementer → reviewer loop, running `claude` directly on the host.

> ⚠️ **Before you run it:** Ralph runs the agent with `--permission-mode bypassPermissions`. By default (`RALPH_RUNNER=sandbox`) Claude Code's native OS sandbox confines writes to your workspace, so the blast radius is the repo tree (git-recoverable). `RALPH_RUNNER=host` removes even that — the agent runs unsandboxed. Only run it against repos, plans, and issues you trust. Full threat model in [SECURITY.md](./SECURITY.md).

## 1. Prerequisites

- **Node.js 20+** with `npm`.
- **Claude Code CLI** (`claude`) on your `PATH`, logged in (next step).
- **macOS** — the native sandbox uses the built-in Seatbelt framework, nothing to install. On **Linux**, install `bubblewrap` + `socat` for the sandbox (`sudo apt-get install bubblewrap socat`), or run with `RALPH_RUNNER=host`.
- **`gh`** — only if you will use `ralph-ghafk` (the GitHub-issue loop).

## 2. Install

```bash
npm i -g @daonhan/ralph
```

Both bins — `ralph-afk` and `ralph-ghafk` — land on your `PATH`.

## 3. One-off auth

Ralph runs `claude` (and `gh`) on the host, so they read your existing host credentials (`~/.claude`, `~/.config/gh`) directly — no container, no mounts. Log in once:

```bash
claude /login         # browser flow — required
gh auth login         # only needed for ralph-ghafk
```

## 4. First run

`<plan-and-prd>` is a single string forwarded verbatim as the `{{ INPUTS }}` template tag — conventionally paths to your plan and PRD files, e.g. `"./docs/plans/x.md ./docs/prd/x.md"`. `<iterations>` is the max loop count. Run from your target repo (or set `RALPH_WORKSPACE`).

### Plan/PRD loop — `ralph-afk`

```bash
ralph-afk "./docs/plans/x.md ./docs/prd/x.md" 5
```

### GitHub-issue loop — `ralph-ghafk`

No plan/PRD arg — context comes from open GitHub issues (`gh issue list`).

```bash
ralph-ghafk 5
```

## 5. How it ends / how to stop

- **Natural stop:** the loop exits as soon as the implementer (the first/gate stage) emits the literal sentinel `<promise>NO MORE TASKS</promise>`. The reviewer never gates.
- **Iteration cap:** otherwise it stops after `<iterations>` iterations.
- **Manual stop:** `Ctrl+C` aborts the active stage and exits `130`.
- **Logs** are written per stage to `<workspace>/.ralph-tmp/logs/*.ndjson` (gitignored).

## 6. For overnight runs

```bash
ralph-afk --detach --notify "./docs/plans/x.md ./docs/prd/x.md" 50
```

Forks to the background, holds an OS wake-lock, and raises a notification when the run finishes or fails.

---

Reference and troubleshooting: [`./README.md`](./README.md). Hacking on Ralph itself: [`./CONTRIBUTING.md`](./CONTRIBUTING.md). Internals: [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
