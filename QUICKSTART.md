# Ralph — Quickstart

Zero-to-first-loop for a brand-new user who just wants to run Ralph against their own repo. Depth lives in [`./README.md`](./README.md).

Ralph drives Claude Code by default, or Codex when selected with `--agent codex`, against your repo in an iterating implementer → reviewer loop isolated inside an ephemeral Docker sandbox.

> ⚠️ **Before you run it:** Ralph runs the selected agent without interactive approval (`--permission-mode bypassPermissions` for Claude; `--dangerously-bypass-approvals-and-sandbox` for Codex) and, by default, bind-mounts the host Docker socket (**root-equivalent access to the host Docker daemon**). Only run it against repos, plans, and issues you trust; set `RALPH_DOCKER_SOCK=0` to disable the socket mount. Full threat model in [SECURITY.md](./SECURITY.md).

## 1. Prerequisites

- **Docker** running — Docker Desktop (Windows/macOS) or Docker Engine (Linux).
- **Node.js 20+** with `npm`. Windows Codex users need Node inside WSL; native Windows Node remains supported for Claude.
- **(Windows Claude, recommended)** `bash.exe` on your `PATH` — comes free with [Git for Windows](https://git-scm.com/download/win). The renderer prefers it over `cmd.exe`; without it, it falls back to `cmd.exe`.
- **(Windows Codex)** WSL with a normal Linux home under `/home/<user>`.
- **`gh`** — only if you will use `ralph-ghafk` (the GitHub-issue loop).

## 2. Install

```bash
npm i -g @daonhan/ralph
```

Both bins — `ralph-afk` and `ralph-ghafk` — land on your `PATH`.
On Windows, run this install inside WSL if you will use Codex.

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

Credentials live on the **host** (`~/.claude` or `~/.codex`, plus `~/.config/gh`) and the selected provider's credentials get bind-mounted into each container. Log in once for the provider you will use. If you will run `ralph-ghafk`, authenticate GitHub separately after the provider login.

**Same-shell rule:** credentials resolve against `$HOME` of the shell that launches the bin, and PowerShell `$HOME` (`C:\Users\<you>`) and WSL `$HOME` (`/home/<you>`) are separate stores — auth from the same shell context you will run the bins from. Native PowerShell and Git Bash homes are valid for Claude; Windows Codex requires WSL and a WSL Linux home.

Choose one provider login path below. Claude and Codex authentication are
mutually exclusive; GitHub authentication is provider-independent and required
only for `ralph-ghafk`.

### Claude login

#### Linux / macOS / WSL bash

```bash
mkdir -p ~/.claude
touch ~/.claude.json

docker run -it --rm \
  -v "$HOME/.claude:/home/agent/.claude" \
  -v "$HOME/.claude.json:/home/agent/.claude.json" \
  docker.io/daonhan/ralph-sandbox:latest bash
```

#### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude" | Out-Null
if (-not (Test-Path "$HOME\.claude.json")) { New-Item -ItemType File "$HOME\.claude.json" | Out-Null }

docker run -it --rm `
  -v "${HOME}\.claude:/home/agent/.claude" `
  -v "${HOME}\.claude.json:/home/agent/.claude.json" `
  docker.io/daonhan/ralph-sandbox:latest bash
```

#### Inside the container

```bash
claude /login         # browser flow; Claude only
exit
```

### Codex login

Use this path instead when you select Codex. On Windows, native PowerShell, cmd,
and Git Bash are not supported Codex launch contexts. Open WSL, then install the
host CLI version pinned in Ralph's sandbox from the same WSL shell that will
launch Ralph. On Linux and macOS, use the same native shell for both:

```bash
npm install --global @openai/codex@0.144.4
codex --version
```

Codex credentials must be file-backed because a host OS keyring is not
available inside Docker. Create `~/.codex/config.toml` if needed and set:

```toml
cli_auth_credentials_store = "file"
```

Then authenticate in that same shell:

```bash
codex login
codex login status
```

Ralph mounts `~/.codex` read-write at `/home/agent/.codex` so Codex can refresh
the login. On Windows, keep `~/.codex` under `/home/<user>` in the WSL distro's
Linux filesystem; the target workspace may still live under `/mnt/c` or
`/mnt/d`. A native NTFS-backed mount fails when Codex performs required
`chmod`/`fchmod` operations (`EPERM`). Switching only the command shell is not
enough if the active Codex home still points at the Windows filesystem. Ralph
runs Codex with `--ephemeral`, so stage session transcripts are not persisted
there.

Codex ignores the rest of `~/.codex/config.toml` by default. Use
`--codex-user-config` only when you intentionally want its model settings, MCP
servers, and hooks inside the Linux sandbox. `RALPH_MODEL` applies to either
provider; without it, isolated Codex uses `gpt-5.6-sol` with high reasoning.
An explicit invalid model fails the stage rather than falling back.

### GitHub login (`ralph-ghafk` only)

Skip this section when you use only `ralph-afk`. For `ralph-ghafk`, authenticate
GitHub regardless of whether you selected Claude or Codex.

#### Linux / macOS / WSL bash

```bash
export GH_CONFIG_DIR="$HOME/.config/gh"
mkdir -p "$GH_CONFIG_DIR"
gh auth login
gh auth status
```

#### Windows PowerShell

```powershell
$env:GH_CONFIG_DIR = "$HOME\.config\gh"
New-Item -ItemType Directory -Force $env:GH_CONFIG_DIR | Out-Null
gh auth login
gh auth status
```

Native Windows `gh` otherwise defaults to its AppData directory, which Ralph
does not mount. Keep `GH_CONFIG_DIR` set when you invoke `ralph-ghafk` from this
PowerShell session; set it again before the invocation if you open a new one.
On Linux, macOS, and WSL, keep the exported `GH_CONFIG_DIR` in the same shell for
`gh auth status` and `ralph-ghafk`; export it again in a new shell before either
command. This pins `gh` to the configuration directory Ralph mounts even when
`XDG_CONFIG_HOME` differs.

Ralph renders GitHub issue data with the host `gh` command, then mounts the same
configuration read-only at `/home/agent/.config/gh` for the stage.

## 5. First run

`<plan-and-prd>` is a single string forwarded verbatim as the `{{ INPUTS }}` template tag — conventionally paths to your plan and PRD files, e.g. `"./docs/plans/x.md ./docs/prd/x.md"`. `<iterations>` is the max loop count. Run from your target repo (or set `RALPH_WORKSPACE`).

### Plan/PRD loop — `ralph-afk`

Claude remains the default. Select Codex per invocation with `--agent codex`;
`RALPH_AGENT=codex` is the fallback when that flag is absent.

Linux / macOS / WSL bash (use WSL for Codex on Windows):

```bash
ralph-afk "./docs/plans/x.md ./docs/prd/x.md" 5
ralph-afk --agent codex "./docs/plans/x.md ./docs/prd/x.md" 5
```

PowerShell (Claude only):

```powershell
ralph-afk "./docs/plans/x.md ./docs/prd/x.md" 5
```

### GitHub-issue loop — `ralph-ghafk`

No plan/PRD arg — context comes from open GitHub issues (`gh issue list`).

Linux / macOS / WSL bash (use WSL for Codex on Windows):

```bash
export GH_CONFIG_DIR="$HOME/.config/gh"
ralph-ghafk 5
ralph-ghafk --agent codex 5
```

PowerShell (Claude only):

```powershell
$env:GH_CONFIG_DIR = "$HOME\.config\gh"
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
