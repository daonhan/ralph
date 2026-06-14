# Design: Drop Docker for a host-first native-sandbox runner (+ paced sub-agent features)

Date: 2026-06-14
Status: Approved (brainstorm), pending spec review → implementation plan
Branch: `simplify/drop-docker-native-sandbox`

## Summary

Ralph currently runs every stage inside an ephemeral `ralph-sandbox` Docker
container. On macOS — the only supported target going forward — Docker can be
replaced by **Claude Code's native OS sandbox** (Seatbelt) with an *equivalent*
blast radius, while deleting the largest knot of code in the repo. This document
covers two things:

1. **Part 1 (implement now):** remove Docker entirely; run `claude` directly on
   the host with the native sandbox as the safety net. Host-first, sandbox-by-default.
2. **Part 2 (design now, implement as a follow-up):** a **paced sub-agent
   reviewer panel** with a **token/cost budget + cooldown** baked in, plus an
   optional **watch/daemon mode**.

Non-goals: Windows support (explicitly dropped), preserving the published Docker
image, preserving the bundled `.NET`/toolchain (the host provides it).

## Background — why Docker can go

Docker does three jobs today:

| Job | Replacement on macOS |
| --- | --- |
| Blast-radius bounding for `bypassPermissions` | Seatbelt confines **writes to the working dir** by default — same effective reach as today's `RALPH_DOCKER_SOCK=0` mode (workspace-only, git-recoverable). Composes with `bypassPermissions` *by design*: the OS boundary is the safety net that makes auto-approve acceptable. |
| Bundled toolchain (Node/.NET/gh/jq/git) | The host already has the user's toolchain. The `MSB3248` workaround in `prompt.md`/`review.md` was a Docker **virtiofs** artifact — it disappears. |
| Credential mounts (`~/.claude`, `~/.config/gh`) | `claude` and `gh` on the host read these natively. No mounts. |

Confirmed via Claude Code sandbox docs: native sandbox works in headless
`--print` mode; `autoAllowBashIfSandboxed` (default `true`) auto-runs bash inside
the sandbox without prompts; together with `bypassPermissions` this yields a
non-interactive run bounded to the workspace.

## Part 1 — Host-first native-sandbox runner

### Runner model

`runStage` stops constructing a `docker run …` argv and instead spawns `claude`
directly with `cwd = workspaceDir`. The mode is selected by `RALPH_RUNNER`:

- **`sandbox` (default):** generate a transient settings JSON enabling the
  Seatbelt sandbox, pass it via `claude --settings <file>`, keep
  `--permission-mode bypassPermissions`. Writes are confined to the workspace.
- **`host`:** identical spawn, **no** sandbox settings — the bare while-loop
  escape hatch (Linux without bubblewrap, or deliberately unconfined runs).
  Safety rests on `cwd` + git, as the original Ralph technique did.

The spawned argv (sandbox mode):

```
claude --verbose --print --output-format stream-json \
  --permission-mode bypassPermissions \
  --settings <transient-sandbox-settings.json> \
  [--model <RALPH_MODEL>] \
  "Read the full instructions from ./.ralph-tmp/<file> ... and execute them."
```

### Transient sandbox settings

Written to the per-iteration scratch area (e.g.
`<workspace>/.ralph-tmp/.sandbox-<pid>-<iter>.json`), cleaned in `finally`
alongside the prompt file. Shape:

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": { "allowWrite": ["<absolute workspaceDir>"] }
  }
}
```

- **Filesystem:** writes confined to the workspace. `.ralph-tmp/` lives inside
  the workspace, so the prompt/spill/log files remain writable.
- **Network — deliberate tradeoff.** Seatbelt's network default is *stricter*
  than Docker (Docker did not restrict network at all; Seatbelt prompts on first
  domain, which would **stall a non-interactive run** during `pnpm install` /
  `dotnet restore` / `git push`). Default: **leave network unrestricted**
  (filesystem-only sandboxing is the real blast-radius control). A
  `RALPH_SANDBOX_NET` knob accepts a comma-separated allowlist to opt into egress
  control (`sandbox.network.allowedDomains`). The exact key to express
  "filesystem-sandbox-only, network unrestricted" is verified during
  implementation (see Open Questions).

### Code changes

| File | Change |
| --- | --- |
| `runner.ts` | **633 → ~150 lines.** Delete `detectDockerSocketPath`, `parseDockerHost`, `resolveDockerSocketMount`, `isFloatingRef`, `resolveDockerfile`, `resolveBuildAfterPullFail`, `runDockerCommand`, `ensureImageSync/Async/ensureImage`, the credential-mount block, and docker argv in `buildClaudeArgs`. Keep `streamClaude` (renamed from `streamDocker` — spawns `claude` not `docker`), the grace timer, `parseGraceMs`, `resolveModelArgs`, `stageLogPath`. Add `writeSandboxSettings` + `resolveRunner`. `buildClaudeArgs` now returns the `claude` flags only (no image ref). |
| `loop.ts` | Drop the `ensureImage(ralphDir, …)` call (no image to ensure). Drop `ralphDir` from `LoopOptions`. Otherwise unchanged — retry, sentinel gate, signal handling, spill plumbing all stay. |
| `run-bin.ts` | Drop `ralphDir` resolution and the `RALPH_DOCKER_CONTEXT` read. |
| `cli-help.ts` | Drop docker fields from `--print-config`; add `runner` + sandbox-net to the printed config. |
| `stages.ts` | Update the blast-radius comment (sandbox, not container). `permissionMode` stays `bypassPermissions`. |
| `render.ts` | **Unchanged.** Host shell tags already ran on the host. |
| Templates | `afk.md` / `ghafk.md` / `review.md` unchanged (relative `./.ralph-tmp/...` paths still resolve, cwd is the workspace). **Remove** the `MSB3248` virtiofs workaround block from `prompt.md` and `review.md`. |
| Deleted files | `packages/core/templates/Dockerfile`, `.github/workflows/publish-image.yml`, the `ralph-sandbox` release-please component config, `templates/CHANGELOG.md` (image), SECURITY.md docker.sock section. |
| Docs | `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md`, `RELEASING.md` updated: remove image build/publish/socket sections; document `RALPH_RUNNER` / `RALPH_SANDBOX_NET`; drop `RALPH_IMAGE`, `RALPH_DOCKER_CONTEXT`, `RALPH_DOCKER_SOCK[_PATH]`. |

### Env var changes

- **Removed:** `RALPH_IMAGE`, `RALPH_IMAGE_TAG`, `RALPH_DOCKER_CONTEXT`,
  `RALPH_DOCKER_SOCK`, `RALPH_DOCKER_SOCK_PATH`.
- **Added:** `RALPH_RUNNER` (`sandbox` default | `host`), `RALPH_SANDBOX_NET`
  (optional egress allowlist).
- **Unchanged:** `RALPH_WORKSPACE`, `RALPH_MODEL`, `RALPH_RESULT_GRACE_MS`,
  `NO_COLOR`/`TERM`.

### Tests

- `runner.test.ts`: replace docker-argv assertions with `claude`-argv assertions
  (`buildClaudeArgs` produces the expected flags; `resolveRunner` honors
  `RALPH_RUNNER`; `writeSandboxSettings` emits the expected JSON; sandbox mode
  adds `--settings`, host mode omits it). Delete socket-detection tests.
- `loop.test.ts`: drop `ensureImage` expectations; verify the gate/sentinel and
  retry paths still hold with the new runner.
- Verification gate (unchanged commands): `pnpm -r typecheck` + `pnpm -r test` +
  root `pnpm test`.

## Part 2 — Paced sub-agent reviewer panel + budget (design; build next)

Built on data Ralph **already streams**: the `result` NDJSON event carries
`total_cost_usd`, `usage`, and `num_turns`.

### A. Token/cost budget + adaptive pacing (baked into the panel)

- Accumulate `total_cost_usd` / token usage across stages and iterations.
- `--budget <usd>`: stop the loop cleanly when cumulative cost exceeds the cap
  (report where it stopped; preserve committed work).
- `--cooldown <ms>`: fixed sleep between iterations/sub-agents.
- **Adaptive backoff:** when a stage result signals rate-limit pressure (error
  text / usage spike), grow the cooldown before the next invocation. This is the
  concrete answer to "delay sometimes to prevent token limit."

### B. Paced reviewer panel

- Optionally fan the single reviewer stage into **K lenses** (e.g. correctness /
  security / tests) as **separate `claude --print` invocations**.
- The **harness owns concurrency + cooldown** between sub-agents, so they never
  burst past a rate limit — pacing is a first-class control, not a side effect.
- A **synth step** merges the panel's findings into a single `fix(review):`
  commit (or `<review>OK</review>` when all lenses are clean).
- New stage type: a fan-out stage descriptor in `stages.ts` + new lens templates;
  wired behind a flag (`--review-panel` / `RALPH_REVIEW_LENSES`) so default
  behavior is unchanged.

### C. Watch/daemon mode (bonus, out-of-box)

- `ralph-ghafk --watch`: idle → poll for newly-labeled open issues → run the loop
  → return to idle. Naturally paired with `--budget`/`--cooldown` from A.
- Reuses the existing keepalive + notify machinery.

## Sequencing

1. **This pass:** Part 1 (host-first sandbox runner; Docker fully removed; tests
   green; docs updated).
2. **Follow-up 1:** Part 2 A+B (budget/cooldown + paced reviewer panel).
3. **Follow-up 2:** Part 2 C (watch mode).

Each follow-up is its own spec → plan → implementation cycle.

## Open questions (verify during implementation)

1. Exact settings shape for **filesystem-sandbox-on, network-unrestricted** (vs.
   having to enumerate `allowedDomains`). Confirm against the installed `claude`
   version. Fallback: a broad `allowedDomains` default if "unrestricted" can't be
   expressed.
2. `--settings` accepting a **file path** (and/or inline JSON) on the installed
   `claude` version — confirm via `claude --help`. Fallback: write
   `<workspace>/.claude/settings.local.json` for the duration of the run.
3. Whether `gh` (Go TLS under Seatbelt) needs `excludedCommands` for in-sandbox
   `gh` calls. Note: the templates' `gh`/`git` shell tags run on the **host**
   during render, not in the sandbox, so this only affects `gh` calls the agent
   itself makes inside a stage.
4. Linux fallback behavior for `RALPH_RUNNER=sandbox` when bubblewrap is absent
   (degrade to `host` with a warning, or hard error?). macOS is primary; pick the
   least-surprising default.

## Success criteria

- `pnpm -r typecheck`, `pnpm -r test`, root `pnpm test` all green.
- `ralph-afk "<plan>" 1` and `ralph-ghafk 1` complete a stage with **no Docker
  invoked** (default `sandbox` runner), writes confined to the workspace.
- `RALPH_RUNNER=host` runs unconfined; `--print-config` reflects the active
  runner.
- `runner.ts` materially smaller; no remaining references to the deleted env
  vars or the Docker image across src/docs/CI.
