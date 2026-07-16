# Ralph — Quickstart

Zero-to-first-loop for a brand-new user who just wants to run Ralph against their own repo. Depth lives in [`./README.md`](./README.md).

Ralph drives [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) against your repo in an iterating implementer → reviewer loop, isolated inside an ephemeral Docker sandbox.

> ⚠️ **Before you run it:** Ralph runs the agent with `--permission-mode bypassPermissions` and, by default, bind-mounts the host Docker socket (**root-equivalent access to the host Docker daemon**). Only run it against repos, plans, and issues you trust; set `RALPH_DOCKER_SOCK=0` to disable the socket mount. Full threat model in [SECURITY.md](./SECURITY.md).

## 1. Prerequisites

- **Docker** running — Docker Desktop (Windows/macOS) or Docker Engine (Linux).
- **Node.js 20+** with `npm`.
- **(Windows, recommended)** `bash.exe` on your `PATH` — comes free with [Git for Windows](https://git-scm.com/download/win). The renderer prefers it over `cmd.exe`; without it, it falls back to `cmd.exe`.
- **`gh`** — only if you will use `ralph-ghafk` (the GitHub-issue loop).

## 2. Install

```bash
npm i -g @daonhan/ralph
```

Both bins — `ralph-afk` and `ralph-ghafk` — land on your `PATH`.

## 3. Get the sandbox image

```bash
docker pull docker.io/daonhan/ralph-sandbox:latest
```

(Ralph also auto-pulls on first run; this just primes the cache.)

The image already provides Debian Bookworm Python 3.11 as `python` and `python3`,
`python -m venv`, and `uv`/`uvx` 0.11.28, so basic Python repositories need no
extra runtime install. Use a project-local virtual environment or uv-managed
isolation; do not install project dependencies globally into the Debian system
Python.

This release does not select pinned Python versions from `.python-version`,
`.tool-versions`, `.mise.toml`, `pyproject.toml`, or similar manifests. A repository
that requires another Python version needs a custom image until future detection
support is added.

## 4. One-off auth

Credentials live on the **host** (`~/.claude`, `~/.config/gh`) and get bind-mounted into every container. Log in once via an interactive container.

**Same-shell rule:** credentials resolve against `$HOME` of the shell that launches the bin, and PowerShell `$HOME` (`C:\Users\<you>`) and WSL `$HOME` (`/home/<you>`) are separate stores — auth from the same shell context you will run the bins from.

### Linux / macOS / WSL bash

```bash
mkdir -p ~/.claude ~/.config/gh
touch ~/.claude.json

docker run -it --rm \
  -v "$HOME/.claude:/home/agent/.claude" \
  -v "$HOME/.claude.json:/home/agent/.claude.json" \
  -v "$HOME/.config/gh:/home/agent/.config/gh" \
  docker.io/daonhan/ralph-sandbox:latest bash
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude","$HOME\.config\gh" | Out-Null
if (-not (Test-Path "$HOME\.claude.json")) { New-Item -ItemType File "$HOME\.claude.json" | Out-Null }

docker run -it --rm `
  -v "${HOME}\.claude:/home/agent/.claude" `
  -v "${HOME}\.claude.json:/home/agent/.claude.json" `
  -v "${HOME}\.config\gh:/home/agent/.config/gh" `
  docker.io/daonhan/ralph-sandbox:latest bash
```

### Inside the container

```bash
claude /login         # browser flow — required
gh auth login         # only needed for ralph-ghafk
exit
```

## 5. First run

`<plan-and-prd>` is a single string forwarded verbatim as the `{{ INPUTS }}` template tag — conventionally paths to your plan and PRD files, e.g. `"./docs/plans/x.md ./docs/prd/x.md"`. `<iterations>` is the max loop count. Run from your target repo (or set `RALPH_WORKSPACE`).

### Plan/PRD loop — `ralph-afk`

bash:

```bash
ralph-afk "./docs/plans/x.md ./docs/prd/x.md" 5
```

PowerShell:

```powershell
ralph-afk "./docs/plans/x.md ./docs/prd/x.md" 5
```

### GitHub-issue loop — `ralph-ghafk`

No plan/PRD arg — context comes from open GitHub issues (`gh issue list`).

bash:

```bash
ralph-ghafk 5
```

PowerShell:

```powershell
ralph-ghafk 5
```

## 6. How it ends / how to stop

- **Natural stop:** the loop exits as soon as the implementer (the first/gate stage) emits the literal sentinel `<promise>NO MORE TASKS</promise>`. The reviewer never gates.
- **Iteration cap:** otherwise it stops after `<iterations>` iterations.
- **Manual stop:** `Ctrl+C` aborts the active stage and exits `130`.
- **Logs** are written per stage to `<workspace>/.ralph-tmp/logs/*.ndjson` (gitignored).

## 7. For overnight runs

```bash
ralph-afk --detach --notify "./docs/plans/x.md ./docs/prd/x.md" 50
```

Forks to the background, holds an OS wake-lock, and raises a notification when the run finishes or fails.

---

Reference and troubleshooting: [`./README.md`](./README.md). Hacking on Ralph itself: [`./CONTRIBUTING.md`](./CONTRIBUTING.md). Internals: [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
