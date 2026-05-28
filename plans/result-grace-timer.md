# Plan: Post-result grace timer in `streamDocker`

> Source PRD: [daonhan/ralph#29](https://github.com/daonhan/ralph/issues/29) — recover from claude CLI hangs that survive past the final `result` NDJSON event.

## Architectural decisions

Durable decisions that apply across every phase:

- **Scope of change**: single function (`streamDocker`) in `packages/core/src/runner.ts`, plus one new pure helper colocated in the same file, plus a doc line in `README.md`. No new files. No changes to `runStage`, `runLoop`, `stages.ts`, or the bins.
- **Env var contract**: `RALPH_RESULT_GRACE_MS`. Default `30000`. `0` = disabled. Unset / empty / NaN / negative → default. Read directly from `process.env` inside the runner (matches `RALPH_IMAGE` / `RALPH_DOCKER_SOCK` pattern).
- **Trigger condition**: first NDJSON event with `type === "result"` arms a one-shot `setTimeout`. Subsequent `result` events do not re-arm.
- **Settlement contract**: on timer fire, kill the docker child (default signal, matches existing abort path) and **resolve** the stage promise with the `finalResult` already captured from the stream — do not reject. The loop driver must see a normal stage completion.
- **Settle-once guarantee**: timer is cleared inside the existing `finish()` guard on every terminal path (natural close, abort, error, grace-fire).
- **User-visible signal**: one dim stderr line via the existing `dim()` helper when the grace timer fires, naming the threshold.
- **Verification standard**: `pnpm -r typecheck` + manual smoke. No test suite is introduced (matches `CLAUDE.md` convention).

---

## Phase 1: Land the grace timer end-to-end

**User stories**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 (all PRD stories).

### What to build

End-to-end behavior: when a stage's docker child emits a final `result` NDJSON event but fails to exit cleanly, ralph waits up to `RALPH_RESULT_GRACE_MS` ms (default 30000), then kills the child and resolves the stage with the captured result text so the loop advances to the next stage. The behavior is opt-out via `RALPH_RESULT_GRACE_MS=0`. A single dim stderr line is emitted on kill explaining the threshold. The env var is documented alongside the other `RALPH_*` knobs in `README.md`.

### Acceptance criteria

- [ ] `pnpm -r typecheck` is clean from the repo root.
- [ ] In a healthy run (`ralph-afk` against a tiny target workspace that completes a stage normally), the new grace timer never fires — no kill line on stderr, and the existing successful-completion code path is unchanged.
- [ ] In an induced-hang run (a stage whose child emits `result` then stays alive past the grace period — reproducible by either replaying the captured iter4 NDJSON against a `sleep infinity` stand-in or temporarily wrapping the template body in a long-running background process), ralph emits exactly one dim stderr line naming the grace-period threshold, the container is killed, the stage promise resolves with the captured `finalResult` string, and the next stage starts.
- [ ] With `RALPH_RESULT_GRACE_MS=0` set, the induced-hang scenario reproduces the original behavior — ralph waits indefinitely on `child.close` and the operator must `docker kill` manually.
- [ ] With `RALPH_RESULT_GRACE_MS=` set to a non-finite or negative value (e.g. `abc`, `-5`), behavior falls back to the 30000ms default (no crash, no NaN timer).
- [ ] Aborting a hung run via SIGINT (Ctrl+C) before the grace timer fires kills the child immediately via the existing abort path — the grace timer is cleared and does not fire afterwards.
- [ ] A natural docker close (the common case) clears the grace timer if it was armed — no spurious kill line on stderr after the stage completes.
- [ ] The stage promise settles exactly once in every code path (timer-fire, natural-close, abort, docker-error). No "promise already settled" warnings.
- [ ] `streamDocker`'s exported signature is unchanged. `runStage` and `runLoop` are untouched.
- [ ] `README.md` documents `RALPH_RESULT_GRACE_MS` in the same section as the other `RALPH_*` env vars, including the default and the `0` opt-out value.
- [ ] No new dependencies added to any `package.json`. No new files outside `plans/` and the PRD scratch under `.ralph-tmp/`.
