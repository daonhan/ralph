# CONTEXT.md — one-page map of Ralph

Orientation for anyone (human or agent) opening this repo cold. Deliberately short: every section points at the file that owns the detail. Operational rules for AI agents live in [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md).

## What it is, in one paragraph

Ralph runs a coding agent unattended ("AFK") against a target repo. Each iteration renders a prompt template on the host, starts a throwaway Docker container (`ralph-sandbox`) with the target repo bind-mounted, and streams the agent CLI's JSONL output back. An **implementer** stage does work; a **reviewer** stage critiques it. The implementer is the **gate**: when its final message carries `<promise>NO MORE TASKS</promise>` on a line of its own, the loop stops early. Otherwise it runs until the iteration cap. Claude Code is the default agent; Codex is selectable per run.

## Shape of the repo

```
packages/core/          @daonhan/ralph-core  — TS library, compiled to dist/ (ESM)
  src/                  loop spine + AFK machinery (see "Read path")
  src/agents/           provider adapters: claude.ts, codex.ts, index.ts (registry), types.ts
  src/__tests__/        vitest suite
  templates/            prompt templates (afk/ghafk/review.md, prompt/ghprompt.md playbooks) + skills/ralph-tdd/ + Dockerfile
apps/cli/               @daonhan/ralph — hand-written JS bins ralph-afk / ralph-ghafk, no build
scripts/                repo-level node --test checks + smoke scripts (image, render, spill)
images/pg17/            sandbox variant with PostgreSQL 17 + PostGIS (local build only)
docs/                   ARCHITECTURE.md (runtime reference), prd/ + plans/ per feature, superpowers/ design docs
.github/workflows/      release-please (npm + image) and image publish
```

Two entry points, same loop, different first stage:

| Bin           | Chain                            | Input                    |
| ------------- | -------------------------------- | ------------------------ |
| `ralph-afk`   | `implementer` → `reviewer`       | plan/PRD string argument |
| `ralph-ghafk` | `ghafk-implementer` → `reviewer` | none (reads `gh` issues) |

## Read path (in this order)

1. `packages/core/src/main.ts`, `gh-main.ts`, `run-bin.ts` — parse flags, pick agent, resolve dirs, call `runLoop`.
2. `loop.ts` — the iteration driver, sentinel gate, retries, signals, history writes.
3. `render.ts` — template tag expansion (`@include`, `@spill`, `` !?` ` ``, `` !` ` ``, `{{ INPUTS }}`). Runs shell on the **host**.
4. `runner.ts` — `ensureImage` (inspect → pull → build) and `runStage` (tempfile prompt, `docker run`, JSONL stream, `{ text, meta }`).
5. `agents/types.ts` then `agents/claude.ts` / `agents/codex.ts` — how each provider is invoked, mounted, and decoded.
6. `stages.ts`, `history.ts`, `stream-render.ts` — stage registry, per-run Markdown history, terminal pretty-printer.
7. `templates/afk.md` + `prompt.md` — what the agent is actually told. Edit these to change behavior, not the loop. The implementer playbooks call the shipped `ralph-tdd` skill from `templates/skills/`, mounted read-only into every stage.

Deeper: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the end-to-end data flow, the exact `docker run` argv, and the env-var table.

## Invariants (things the code cannot express)

- **First stage gates, always.** Only index 0 of a chain is sentinel-checked. The reviewer never stops the loop.
- **The loop is provider-neutral.** Provider differences live entirely in `agents/`. Never branch `loop.ts` or `render.ts` on agent name.
- **Every stage bypasses approvals.** Claude runs with `bypassPermissions`; Codex with `--dangerously-bypass-approvals-and-sandbox`. This is required for AFK and is why the sandbox exists. Read [SECURITY.md](SECURITY.md) before changing mounts or permissions.
- **Docker socket is mounted by default.** Gives the sandbox host-Docker access (for Testcontainers). Opt out with `RALPH_DOCKER_SOCK=0`.
- **Templates are trusted code.** Shell tag bodies run on the host with no sanitization; `{{ INPUTS }}` is the only user-controlled substitution and is expanded last, after all shell tags.
- **ESM with `.js` import suffixes** in TS sources. `apps/cli` stays plain JS.
- **History is harness-owned.** `loop.ts` writes `<workspace>/.ralph/history/`; agents and templates never touch it.
- **`CLAUDE.md` and `AGENTS.md` are twins.** Change both.

## Key knobs

| Knob                                    | Purpose                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `--agent claude\|codex` / `RALPH_AGENT` | Provider selection                                       |
| `RALPH_MODEL`                           | Model override for the selected provider                 |
| `RALPH_WORKSPACE`                       | Target repo (default cwd)                                |
| `RALPH_IMAGE` / `RALPH_DOCKER_CONTEXT`  | Sandbox image ref / build-fallback context               |
| `RALPH_DOCKER_SOCK=0`                   | Disable host Docker socket mount                         |
| `RALPH_ISOLATE_NODE_MODULES`            | Container-local sandbox `node_modules` (on except Linux) |
| `RALPH_CLAUDE_UPDATE=0`                 | Skip the per-stage `claude update` + its cache volume    |
| `RALPH_RESULT_GRACE_MS`                 | Kill timer after the agent reports completion            |
| `--detach`, `--notify`, `--max-retries` | AFK ergonomics (background run, toast, retry budget)     |
| `--print-config`                        | Show resolved workspace / image / agent / model, no run  |

Full list with defaults: [docs/ARCHITECTURE.md § Environment variables](docs/ARCHITECTURE.md#environment-variables).

## Verify a change

```bash
pnpm -r typecheck && pnpm -r test && pnpm test
```

Pre-commit runs prettier on staged files then typecheck. Image changes: `pnpm smoke:image` (see CONTRIBUTING "Verify sandbox image changes").

## Gotchas that have cost time

- **Windows shell.** `render.ts` picks `bash.exe` from `PATH` if found, else `cmd.exe`. Use the `!?` try-shell form for anything that might not exist under `cmd.exe`.
- **Same-shell credentials.** PowerShell and WSL have different `$HOME`. Log in (`claude`, `codex`, `gh`) from the shell you will launch Ralph from.
- **The sandbox never sees `~/.gitconfig`.** `runStage` passes the host's `user.name`/`user.email` in as `GIT_CONFIG_*` (resolved with `git -C <workspace> config --get`, so a repo-local identity still wins). With no identity set anywhere, nothing is injected, Ralph warns once on stderr, and commits made in the sandbox carry an author the agent makes up.
- **Codex `CODEX_HOME` cannot be a bind mount on Windows** (EPERM). Credentials are mounted read-only elsewhere and copied in by a setup script.
- **Sandbox CLI default model is frozen at image build** (each Claude stage runs `claude update` first, but not under `RALPH_CLAUDE_UPDATE=0` or offline). Ralph always passes `--model` explicitly so it tracks the host's setting.
- **`pnpm link --global` breaks here.** Use `pnpm pack` + `npm i -g` to smoke-test the tarballs.
- **Node modules built in WSL break native-Windows bins** (husky, prettier). Reinstall from the environment you commit from.
- **A sandbox install rewrites the bind-mounted `node_modules`** the same way (Linux store path, Linux symlinks, a stray `.pnpm-store/`). Container-local `node_modules` volumes prevent it by default off Linux (`RALPH_ISOLATE_NODE_MODULES`); as the backstop, Ralph warns on stderr at loop end and the history footer carries `warning: sandbox-install`; reinstall on the host.
- **Leaked `.ralph-tmp/.run-*.md` after a hard kill** are safe to delete; NDJSON logs under `.ralph-tmp/logs/` are kept on purpose.

## Where to go for…

- Using Ralph on a project → [README.md](README.md), [QUICKSTART.md](QUICKSTART.md)
- Runtime internals → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Contributing, adding a stage or provider → [CONTRIBUTING.md](CONTRIBUTING.md)
- Cutting a release, rollback → [RELEASING.md](RELEASING.md)
- Threat model → [SECURITY.md](SECURITY.md)
- Why a feature exists → `docs/prd/<feature>.md`; how it was built → `docs/plans/<feature>.md`
