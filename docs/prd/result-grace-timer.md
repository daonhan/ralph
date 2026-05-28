# PRD: Post-result grace timer in `streamDocker`

> Tracking: [daonhan/ralph#29](https://github.com/daonhan/ralph/issues/29) (PRD) / [daonhan/ralph#30](https://github.com/daonhan/ralph/issues/30) (implementation). Target release: `@daonhan/ralph-core` 0.6.1.

## Problem Statement

When `ralph-ghafk` (or `ralph-afk`) runs an iteration, the claude CLI inside the sandbox container occasionally emits its final `result` NDJSON event but does not exit. The host-side `streamDocker` waits on `child.close` (`packages/core/src/runner.ts:599-607`) so the entire loop freezes between stages with no further log activity, no further iterations, and no exit.

Observed instance: `docker ps` showed a `ralph-sandbox` container up 26+ minutes after the iter4 ghafkImplementer stage emitted `{"type":"result","terminal_reason":"completed"}` and closed the target issue. `docker top` revealed the blocker — a bash child of claude executing:

```
until ! pgrep -f "git -C /home/agent/workspace commit" > /dev/null 2>&1; do sleep 5; done; tail -80 /tmp/claude-1000/.../tasks/<id>.output
```

This is claude's shell-snapshot wrapper polling for a backgrounded `git commit` task to drain. `pgrep -f` matches the full argv of any process, and the until-loop's own bash argv contains the literal pattern `git -C /home/agent/workspace commit`, so pgrep finds itself, returns 0, `!` negates to false, the loop sleeps and repeats forever. claude waits on the bash, the container will not exit, ralph waits on the container.

From the user's perspective: ralph appears frozen for a long time after a successful stage, with no actionable signal and no automatic recovery. They have to spot the stale container, run `docker kill <id>` by hand, and accept that the current iteration is lost even though the work was already committed and the issue was already closed.

### Operator workaround (pre-fix)

Until the grace timer ships, the only recovery is manual:

```bash
docker ps --filter ancestor=docker.io/daonhan/ralph-sandbox:latest
docker kill <container-id>
```

The container is started with `--rm`, so killing it removes it. `streamDocker` rejects the current stage with `docker run exited with <code>`, the loop driver crashes the iteration, and the user restarts `ralph-ghafk N`. Work already committed in earlier iterations is preserved (it is on disk in the target workspace and pushed to the remote / GitHub issue), so no data is lost — only the wall-clock spent waiting before the operator noticed the hang.

A concrete instance observed during the investigation that produced this PRD: container `4201c43a1afa` stayed up 26+ minutes after its `result` event before an operator killed it manually.

## Solution

Add a grace-period timer in `streamDocker` that arms when the first `result` NDJSON event is observed. If the docker child has not exited cleanly by the time the timer fires, ralph kills the child and resolves the stage with the `finalResult` string already captured from the stream. The stage therefore completes with its real output, the loop advances to the next stage / next iteration, and the user sees a single line on stderr explaining why the kill happened.

The grace period is configurable via `RALPH_RESULT_GRACE_MS` (default 30000ms). Setting it to 0 disables the behavior for users who want strict child-exit semantics.

From the user's perspective: ralph self-recovers from this class of hang without manual `docker kill`, work is preserved (because the `result` event already carried the output), and the cause is visible in stderr.

## User Stories

1. As a ralph user running `ralph-ghafk N` overnight, I want the loop to keep advancing after a stage emits its `result` event, so that one stuck claude child does not stall my entire run.
2. As a ralph user, I want the stage's `finalResult` to be preserved when the child has to be force-killed, so that the reviewer stage and the gating sentinel check still receive the real output of the implementer.
3. As a ralph user, I want a clear stderr line when ralph kills a hung child, so that I understand why the container disappeared and can diagnose recurring patterns.
4. As a ralph user, I want a default grace period that is generous enough to absorb normal post-result cleanup (a few seconds), so that healthy runs are never killed prematurely.
5. As a ralph user with unusual containers, I want to override the grace period via an environment variable, so that I can tune or disable the behavior without code changes.
6. As a ralph user, I want `RALPH_RESULT_GRACE_MS=0` to fully disable the grace timer, so that I can opt out and keep the original "wait for child.close forever" semantics if I am debugging.
7. As a ralph user, I want the grace timer to be cleared if the child exits cleanly first, so that no timer fires after a normal close and no spurious kill happens.
8. As a ralph user, I want the grace timer cleared on abort (Ctrl+C / signal handler), so that the existing signal-driven cleanup path is not interfered with.
9. As a ralph user, I want the grace timer cleared on docker error, so that error paths still settle cleanly.
10. As a ralph user, I want the kill-and-resolve path to behave like a successful stage completion (resolve, not reject), so that the loop driver in `loop.ts` advances normally instead of crashing the iteration.
11. As a ralph user, I want stages that have no `result` event (genuine hangs with no output) to remain unaffected by this change, so that the new behavior only targets the observed self-deadlock class and does not mask other failures.
12. As a ralph user, I want this change to be transparent when `RALPH_RESULT_GRACE_MS` is unset, so that I get the fix without configuring anything.
13. As a ralph maintainer, I want the helper that parses the env var to be a small pure function, so that the parsing rules are obvious from the code.
14. As a ralph maintainer, I want the env var parsing to reject invalid values (NaN, negative) and fall back to the default, so that a typo cannot disable safety or set a nonsense interval.
15. As a ralph maintainer, I want the implementation to live in `streamDocker` rather than at a higher layer (`runStage`, `runLoop`), so that the fix lands as close as possible to the actual race (NDJSON stream vs. child lifecycle).
16. As a ralph maintainer, I want the change to keep `streamDocker`'s public signature unchanged, so that callers in `runStage` are not touched.
17. As a ralph maintainer, I want the change to preserve the existing `RunStageOptions.signal` abort flow, so that Ctrl+C still terminates the container immediately.
18. As a ralph maintainer, I want the README updated to document `RALPH_RESULT_GRACE_MS` alongside the other `RALPH_*` env vars, so that the knob is discoverable.
19. As a ralph maintainer, I want the change verified by `pnpm -r typecheck` and a manual smoke run, so that verification matches the repo's existing standard (no test suite exists today).
20. As a ralph maintainer, I want the fix to be safe in the worst case (kill SIGTERM fails, child still alive) — at minimum the timer should not double-fire and the promise should not double-settle.
21. As a ralph user, I want the post-fix release notes to document the pre-fix manual recovery procedure (`docker ps --filter ancestor=…` + `docker kill <id>`), so that operators on an older `@daonhan/ralph-core` version still have a runbook for the same hang.
22. As a ralph user, I want the fix to make the manual `docker kill` workaround unnecessary going forward, so that overnight runs do not require human intervention to recover from this class of hang.

## Implementation Decisions

- Modify `streamDocker` in the core runner module to track when the first NDJSON `result` event arrives, arm a one-shot grace timer at that moment, and on timer expiry kill the docker child and resolve the stage promise with the `finalResult` string already captured from the stream.
- Add a small pure helper that resolves the grace period from the environment with a default of 30000ms; treat unset, empty, non-finite, and negative values as "use default"; treat 0 as "disable the timer entirely".
- Use the existing `finish()` settle-once guard to clear the grace timer on every terminal path (natural close, abort, error, grace-fire) so the timer is never leaked and the promise is never settled twice.
- Keep `streamDocker`'s exported signature unchanged. All new state is local to the promise executor.
- Do not add a new env var to `runStage` / `runLoop` plumbing — the runner reads `process.env` directly, matching how `RALPH_IMAGE` and `RALPH_DOCKER_SOCK` are handled in this file.
- Emit a single dim stderr line via the existing `dim()` helper on kill, explaining the grace-period threshold, matching the visual style of the other docker-side messages already written from this file.
- Do not change `child.kill()` signal — use the default SIGTERM (consistent with the existing abort path).
- Document the env var in `README.md` next to the existing `RALPH_*` block.

## Testing Decisions

- The repository intentionally has no test suite or linter (per `CLAUDE.md`: "Verification = `pnpm -r typecheck` + manually invoking the bins"). This PRD adopts the same convention to keep the change surgical.
- Verification matrix:
  1. `pnpm -r typecheck` clean.
  2. Manual smoke A — healthy stage: run `ralph-afk` against a tiny target workspace; confirm the stage completes via natural child close (no kill message on stderr) and the next stage runs.
  3. Manual smoke B — induced hang: temporarily wrap the template body in a long-running background process that survives past the `result` event (or replay the captured iter4 NDJSON against a `docker run … sleep infinity` stand-in); confirm the kill message appears at the grace threshold, the stage returns the captured `finalResult`, and the next stage runs.
  4. Manual smoke C — opt-out: re-run smoke B with `RALPH_RESULT_GRACE_MS=0`; confirm the original hanging behavior is restored (loop blocks; kill the container manually).
- Tests of external behavior only — observable outcomes are: presence/absence of the kill message on stderr, presence/absence of the next stage starting, and the value passed to the loop driver. We do not assert on internal timer state.
- Prior art: none in this repo (no tests exist).

## Out of Scope

- Detecting and recovering from hangs **before** a `result` event is emitted. That requires an idle-stream watchdog and a different threshold; it is a separate concern from the observed self-deadlock.
- Reporting hangs upstream to the claude CLI maintainers. The pgrep-self-match bug lives in claude's shell-snapshot wrapper, not in ralph. Filing it upstream is a follow-up, not part of this PRD.
- Bootstrapping a test runner (vitest, node:test) for the repo. Out of scope; matches the existing "no tests" convention.
- Changes to `runStage`, `runLoop`, or the bins. The fix is local to `streamDocker`.
- Changes to the sandbox `Dockerfile` or templates.
- Per-stage overrides (e.g. different grace for reviewer vs. implementer). One global env var is sufficient for the observed case.

## Further Notes

- The root cause is upstream (claude CLI shell-snapshot wrapper builds an `until ! pgrep -f "<pattern>"` loop whose own argv contains `<pattern>`). Even after that bug is fixed upstream, a post-`result` grace timer is a cheap insurance policy for the whole class of "claude emitted final output but a stray child is keeping PID 1 alive" failures.
- The 30-second default is chosen to be much larger than any healthy post-result cleanup ralph has been observed to require (sub-second in normal runs), and small enough that overnight runs do not waste meaningful wall-clock per stuck stage.
- The `finalResult` capture path is unchanged: the result text is already extracted from the NDJSON stream and stored in a local `finalResult` variable before this PRD's change. The new timer only decides _when_ to settle the promise with that value if the child will not exit on its own.
- The implementation will land on a dedicated branch and be tracked via the issues spawned from this PRD.

## Release

- Target version: **`@daonhan/ralph-core` 0.6.1** (patch bump from 0.6.0).
- Mechanism: lands as a `fix(core): …` conventional commit; release-please picks it up and opens the release PR automatically (no manual `package.json` / `.release-please-manifest.json` edits required).
- `@daonhan/ralph` (CLI) is **not** bumped by this change — the CLI only re-exports `runAfk` from core, so a core patch is enough. If a future commit in the same release cycle touches the CLI bins, release-please will bump the CLI separately.
- Sandbox image (`packages/core/templates`) is unaffected; no `image-v*` tag.
