# PRD: A durable per-run event log a supervisor can read

> Written 2026-09-17 from a design session. It applied the "durable state" pattern (append-only event log + reducer → disposable view) to Ralph, collected the owner's decisions, then took two reviews: a Plan-agent review and a plan-adversary red-team whose verdict was fix-first. Its findings are folded in. Two later plan-adversary passes, one against the committed Phases 1–3 and one against the fold of that review, are folded in too, with owner decisions 9 and 10. The decisions below record those sessions; they are not open options.

## Problem Statement

A caller that drives Ralph unattended cannot tell whether a `ralph-afk` / `ralph-ghafk` run is still running, finished, crashed, or stuck. The main such caller is the slice-cycle supervisor (`~/.claude/skills/slice-cycle/scripts/slice-loop.ps1` and its `LOOP.md` / `PHASES.md` / `HISTORY.md`). Today it reconstructs the run's state from side effects, and each signal is unreliable in a way that has already cost a run.

**Liveness from file timestamps.**

- The supervisor treats a run as alive while the newest of several mtimes is recent: the session transcript, any file in `.ralph-tmp/logs`, the state file (`slice-loop.ps1:191-207`). It kills after 120 min of silence.
- "Is a run in flight?" means an NDJSON log modified in the last 15 min, or a container that bind-mounts the repo (`LOOP.md:69-71`).
- A hung sandbox once kept one stage log growing for 18 h, so plain liveness never aged (`slice-loop.ps1:28-29`). The stage cap that followed is derived from the newest `*.ndjson` CreationTime.

**Container matching that does not match.**

- Docker Desktop reports bind mounts as `/run/desktop/mnt/host/<drive>/…`, so a Windows repo path never matches.
- `Stop-Ralph`'s `-contains $Repo` (`slice-loop.ps1:253`) "never stops this repo's ralph containers on a stall" (`LEARNINGS.md:40-43`).
- Stopping ralph means sweeping `docker.exe` processes by command line and walking to their parents (`slice-loop.ps1:236-255`).

**No verdict until the very end.**

- Ralph exits 0 regardless of how the run ended (`PHASES.md:99`, `:720`).
- The only verdict is the Markdown footer. "No footer = the run never exited normally: still in flight, or the host process died" (`HISTORY.md:13`), which is ambiguous without also querying Docker.
- A failure in an early iteration is invisible in the footer: `runFailed` resets every iteration (`loop.ts:266`).

**Nothing on disk while the image resolves.** History opens only after `ensureImage` (`loop.ts:255-263`), so a `docker pull` of `:latest` once sat for 29 min with "no container, log or history file" (`PHASES.md:97-98`).

**Double launches.** A waiter that watched the docker client declared a run done while its container was still running. The client dies in the gaps between stages. The result was a second run launched beside the first (`LOOP.md:69`). Nothing in Ralph stops two runs in one workspace.

**Root cause.** Ralph's run state lives only in memory: the running totals in `history.ts`, the `current` slot in `loop.ts`, the retry counter inside `withRetries`. Its only on-disk record is a human-readable Markdown projection with no liveness data, written from the moment the image is ready.

## Solution

Each run appends to its own **event log**: `.ralph/history/<run>.jsonl`, next to (and sharing a base name with) the Markdown history.

- **Records:** one JSON record per line, numbered by `seq`, written and **fsynced before the loop acts on it**, starting before image setup.
- **Reducer:** a pure `reduceRunLog` folds the log into a disposable `RunView`. The in-process writer keeps the same view with the same fold, so the view can always be rebuilt from the file.
- **Readers:** the supervisor reads the file directly. The Markdown history becomes a projection of the same events.

Run lifecycle features built on the log:

- **Heartbeat.** Every 30 s while the run is open, a `heartbeat` record carries `lastOutputAt`: when the agent last wrote a JSON record to stdout. Ralph reports ages only. Deciding "stuck" stays with the reader and its thresholds.
- **One live run per workspace.** After its own `run.started` is on disk, a run reads every other log in the directory. If one is still live, or docker still runs a container labelled with another logged run's id, the new run logs `run.ended refused` and exits **75**. Because the check runs after the run's own record is on disk, two launches that race each other both refuse; they never both proceed. A caller retries exit 75 after a jittered wait, so two refused callers do not collide again.
- **Exit codes that report the end.** `failed` exits **1** and `refused` exits **75**. `no-more-tasks` and the iteration cap exit 0, and signals still exit 130/143.
- **Named, labelled containers.** Each stage attempt runs as `ralph-<runId>-i<iter>-s<stageIndex>-a<attempt>` with the label `ralph.run=<runId>`. When Ralph abandons a container (abort, the grace timer, a decoder failure), it fires a detached `docker rm -f <name>`. `docker ps -q --filter label=ralph.run=<runId>` finds the stage containers of a run, orphans included; the chown helper and containers the agent starts through docker.sock carry no label.
- **Retention.** The newest 20 `.jsonl` files that did not end `refused` are kept, plus the newest refused one, and a run never deletes its own log. Markdown history is never pruned.

What a log looks like (abridged):

```jsonl
{"v":1,"seq":1,"at":"2026-09-17T10:15:00.120Z","type":"run.started","runId":"2026-09-17-101500-ghafk-feat-x","pid":18244,"hostname":"DESKTOP-1","platform":"win32","bin":"ghafk","agent":"claude","iterations":5,"inputs":"","branch":"feat-x","version":"0.16.0"}
{"v":1,"seq":2,"at":"2026-09-17T10:15:30.121Z","type":"heartbeat","lastOutputAt":null}
{"v":1,"seq":3,"at":"2026-09-17T10:15:41.803Z","type":"stage.started","iteration":1,"stageIndex":0,"stage":"ghafk-implementer","logPath":".ralph-tmp/logs/2026-09-17T10-15-41-800Z-iter1-ghafk-implementer.ndjson","container":"ralph-2026-09-17-101500-ghafk-feat-x-i1-s0-a1"}
{"v":1,"seq":4,"at":"2026-09-17T10:16:11.804Z","type":"heartbeat","lastOutputAt":"2026-09-17T10:16:09.310Z"}
{"v":1,"seq":61,"at":"2026-09-17T10:41:02.412Z","type":"stage.completed","iteration":1,"stage":"ghafk-implementer","status":"ok","durationMs":1520609,"head":"abc1234","logPath":".ralph-tmp/logs/…","body":"…","meta":{"turns":41,"costUsd":1.12}}
{"v":1,"seq":240,"at":"2026-09-17T12:02:55.019Z","type":"run.ended","reason":"cap","completedIterations":5}
```

How a supervisor reads it:

| The log shows                                             | The run is                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a `run.ended` record                                      | **finished**: trust `reason` over the exit code, because exit 1 also comes from a thrown error (`reason: error`)                                                                                                                                                                                               |
| no `run.ended`; pid alive and still node (same host)      | **running**. Ages to judge: image setup while no `stage.started` has come yet (`now − run.started.at`); stage age (`now − stage.startedAt`); agent silence (`now − max(lastOutputAt, stage.startedAt, stage.retry.at + backoffMs)`), so neither a fresh stage nor a retry backoff in progress reads as silence |
| no `run.ended`; pid gone                                  | **dead** (host process killed). Its container may still run: `docker ps -q --filter label=ralph.run=<runId>` decides, and `docker rm -f $(docker ps -aq --filter label=ralph.run=<runId>)` cleans up                                                                                                           |
| a line that fails to parse, a `seq` gap, a torn last line | fold up to the last good record                                                                                                                                                                                                                                                                                |

- The current run is the newest log that isn't refused. A refused log's `blockedBy` names the run that blocked it.
- To stop a live run, kill `started.pid` first, so it starts no further container, then remove the run's containers by label.
- A caller that gets exit 75 retries after a jittered wait.

## User Stories

1. As a supervisor of unattended runs, I want to know from one file whether a run is still running, so that I stop guessing from NDJSON mtimes and Docker mount paths.
2. As a supervisor, I want to see that a run is still resolving its image, so that a hung `docker pull` is distinguishable from "nothing launched".
3. As a supervisor, I want the age of the current stage and of the agent's last output, so that I can apply my own "stuck" thresholds without scraping the agent stream.
4. As a supervisor, I want to see that a stage is in a retry backoff, so that a legitimate wait before the next attempt is not mistaken for a hang.
5. As a supervisor, I want Ralph's exit code to distinguish a failed run and a refused launch from success, so that the process result means something.
6. As a supervisor, I want a crashed host process to be detectable (pid gone, no end record), so that I can clean up and relaunch without waiting out a staleness window.
7. As a supervisor, I want to stop exactly the containers a run started, so that stall recovery works on Docker Desktop and catches containers orphaned by a killed docker client.
8. As a Ralph user, I want a second launch in the same workspace to be refused while a run is live, so that two loops never commit over each other.
9. As a Ralph user on Windows with WSL, I want a run started from the other environment to be judged sensibly, so that a pid from another pid space neither blocks me forever nor is ignored while that run is active.
10. As a supervisor, I want to see failures from earlier iterations even when the run ends at the cap, so that a `cap` verdict does not hide failed stages.
11. As a Ralph user, I want the run logs to be pruned automatically, so that `.ralph/history/` does not grow without bound.
12. As a Ralph maintainer, I want the Markdown history derived from the same events, so that the human log and the machine log cannot disagree.
13. As a reader of the log, I want torn or corrupt records handled predictably, so that a crash mid-write never makes the whole log unreadable.

## Implementation Decisions

- **Location and naming.**
  - The log is `<ws>/.ralph/history/<yyyy-MM-dd-HHmmss>-<bin>[-<branch>].jsonl`. The base name is the history file's existing name without `.md`, and `runId` is that base name.
  - The file is created with `openSync(path, "wx", 0o600)`.
  - On `EEXIST` (two runs in the same UTC second), the name advances one second and the open is retried, up to 60 times. No `-2` suffix is used: `-` (0x2D) sorts before `.` (0x2E), so a suffixed name would sort before the base name in ordinal order, and PowerShell's culture-aware `Sort-Object` may order it differently again. Advancing the second keeps name order equal to run order for every "newest by name" reader (`loadHistoryTail`, the skill's skim recipe, the claim check).
  - Opening the log creates `.ralph/history/` and its `*` `.gitignore`.
- **Opening order.**
  - The log opens right after the version banner and the `--codex-user-config` validation. That is **before** the wake-lock, the signal handlers and `ensureImage`, so a failed open leaks nothing and a hung pull is visible.
  - Invariant change: "an image failure leaves no `.ralph/`" becomes "an image failure leaves no history `.md`; the log records `run.ended error`".
- **Writer.** A new module `run-log.ts`, fully synchronous.
  - `append(event)` builds `{v:1, seq, at, ...event}`. On a closed writer it is a no-op; on a broken writer it throws.
  - It writes the line with `writeFileSync(fd, line)`, which loops on partial writes. If that throws, some bytes may have landed, so the writer is marked broken and the error rethrown. Every later append throws until the file is closed.
  - Once the write returns, `seq` advances and the record is folded into the in-memory view. `seq` never advances past a failed write.
  - Then `fsyncSync(fd)`. A throw there propagates with the record already counted, so the next record's `seq` follows it and the file still folds.
  - `run.ended` closes the file in a `finally`, whether or not the fsync threw, and later appends are no-ops. This matters because tests mock `process.exit` to throw and the loop keeps running afterwards.
  - The loop's `finally` also closes the file.
  - No new `await` may come before the first `runStage` call. The loop tests count microtask turns (`loop.test.ts:330, 384, 412, 472, 503, 537, 578, 612, 655` on `main`).
- **Events (schema v1).**

  | type              | fields                                                                                                                               |
  | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
  | `run.started`     | `runId, pid, hostname, platform, wslDistro?, bin` (short: `afk`/`ghafk`)`, agent, iterations, inputs, branch?, version` (core)       |
  | `stage.started`   | `iteration, stageIndex, stage, logPath, container`                                                                                   |
  | `stage.retry`     | `iteration, stage, attempt` (the failed one, 1-based)`, error, backoffMs, container` (the next attempt's name)                       |
  | `stage.completed` | the existing `StageEntry`: `iteration, stage, status, durationMs, head, logPath, body, meta?, retries?, attempts?, dirty?`           |
  | `heartbeat`       | `lastOutputAt` (ISO string or `null`)                                                                                                |
  | `run.ended`       | `reason` (`no-more-tasks`/`cap`/`failed`/`aborted`/`error`/`refused`)`, completedIterations, signal?, blockedBy?, findings?, error?` |

  `stage.retry` duplicates what `stage.completed.attempts` records later, but it is the only in-flight signal that a silent agent is inside a backoff.

- **Reducer.**
  - `applyEvent(view, record)` is pure. `reduceRunLog(text) → { events, view, truncated }`.
  - Folding stops, and `truncated` is set, at the first line with any of these problems:
    - it has no trailing newline;
    - it fails `JSON.parse`;
    - `v !== 1`;
    - `seq !== previous + 1`;
    - `at` or `type` is not a string;
    - a known type is missing a required field;
    - it is `run.started` anywhere but first, or anything other than `run.started` first;
    - it comes after `run.ended`.
  - An unknown `type` is skipped. That is the forward-compatibility rule: new event types are additive within v1.
  - From the first published v1 on, adding a required field to a known type bumps `v`; a new optional field does not. PR A ships Phases 1–5 together, so `container` is part of v1.
  - The `v !== 1` stop stays strict. The claim reads a newer log by its mtime instead (see Liveness).
  - `RunView` holds:
    - `started` (all `run.started` fields plus `at`);
    - `stage` (the open stage: `iteration, index, name, startedAt, logPath, container`, and the last `retry {attempt, at, backoffMs}`), cleared by `stage.completed`/`run.ended`;
    - `lastEventAt`, `lastHeartbeatAt`, `lastOutputAt`;
    - `entries` (StageEntry[]);
    - `statusCounts`;
    - `ended`.
- **Heartbeat.**
  - `HEARTBEAT_MS = 30_000`. A `setInterval(...).unref?.()` starts as the first statement inside the loop's `try` and is cleared in `finally`.
  - `lastOutputAt` comes from a new `RunStageOptions.onOutput` callback, which `streamDocker` calls for every JSON line it logs.
  - A failed heartbeat append warns once on stderr and is not rethrown from the timer, so a disk-full error never crashes a stage or leaks the keep-alive child. After a failed fsync the run goes on. After a failed write the writer is broken, and the run fails closed at its next event.
  - Heartbeats continue while the loop's event thread is free. A synchronous `execSync` in the template renderer or a `spawnSync docker volume` can delay one. That is why liveness does not rely on heartbeat age on the same host.
- **Append failure policy.**
  - The run log fails to open, or `run.started` fails to write: the error is thrown before anything is acquired, and the process exits 1.
  - A stage or run event fails on the normal path: fail closed. The loop's `catch` tries `run.ended error` (wrapped) and rethrows. After a failed write that `run.ended` throws too, so the log has no end record, and the pid reads dead once the process exits.
  - A `stage.retry` append fails: `onAttempt` stores the error in `retryLogError` and rethrows it, so `withRetries` rejects at once with no backoff. The stage catch starts `if (err === retryLogError) throw err;` instead of recording a failed stage, and the outer catch tries `run.ended error` (wrapped) and rethrows.
  - A signal handler's append fails: every append there is wrapped, so the wake-lock is released and the exit code is still 130/143.
  - A heartbeat append fails: warn once. A failed fsync leaves the writer usable and the run goes on. A failed write breaks the writer, and the run fails closed at its next event.
- **Liveness.** `runLiveness(view, mtimeMs, probe) → "ended" | "live" | "dead"`.
  - **`ended`:** the log has a `run.ended` record.
  - **`dead`:** no readable `run.started` (an empty file, a torn first line, a wrong first event).
  - **Same host** (`hostname`, `platform` and `wslDistro` all equal):
    - **Own process.** When `started.pid === probe.pid`, the log is `live` iff `probe.ownsRun(started.runId)`.
      - `run-log.ts` keeps a module-level `Set` of the runIds whose logs this process has open: `openRunLog` adds, `close()` deletes.
      - `LivenessProbe` carries `pid: number` and `ownsRun(runId: string): boolean`. `hostProbe()` fills them from `process.pid` and the Set.
      - Why: a relaunch that reuses a killed run's pid isn't refused by itself, and two in-process `runLoop`s still refuse each other.
    - **Any other pid:** the run is `live` when `pidAlive(pid)` and `pidIsNode(pid)`, however old its last record. A run that is hung but alive still blocks relaunch, and the supervisor already kills stalled runs.
    - `pidAlive`: `process.kill(pid, 0)`, with `EPERM` counting as alive. Non-integer and non-positive pids are dead.
    - `pidIsNode` guards against a dead run's pid being reused, which happens often on Windows:
      - win32: `tasklist /FI "PID eq <pid>" /FO CSV /NH`, image name contains `node`;
      - Linux: `/proc/<pid>/comm` contains `node`;
      - others: `ps -p <pid> -o comm=`.
    - Both `execFileSync` probes (`tasklist`, `ps`) run with `timeout: 10_000`.
    - A process confirmed gone (no row, `ENOENT` on `/proc`, `ps` status 1) reads false. Any other probe failure, a timeout included, reads true, erring toward refusal.
  - **Different host or platform:** the run is `live` while the file's mtime is less than `STALE_AFTER_MS` (5 min) old. The pid from another pid space is never probed.
  - **Newer schema.** In `findLiveRun`: when the fold has no `run.started` but the first complete (newline-terminated) line is a JSON object with a numeric `v > RUN_LOG_VERSION`, the log is `live` while its mtime is under `STALE_AFTER_MS`, otherwise `dead`. `parseRecord`'s `v !== 1` check stays strict.
  - Ralph versions from before the log write no `.jsonl`, so they are invisible to the claim.
- **Claim check (one run per workspace).**
  - In `runLoop`, synchronously, right after `run.started` is fsynced: `findLiveRun(historyDir, selfRunId)` reads **every** `.jsonl` except its own, oldest first. A torn or dead newer log therefore cannot hide a live older one, and an unreadable log is skipped.
  - When a run is found live:
    - print `[refused] another ralph run is live in this workspace: pid <pid> on <host>, started <at>, last event <age> ago (<path>)`. A newer-schema log has no readable `run.started`, so its line reads `written by a newer ralph (<path>)` instead;
    - append `run.ended {reason:"refused", completedIterations:0, blockedBy}`;
    - prune (see Retention);
    - resolve `"refused"`.
  - **The claim also asks docker** (owner decision 9). It catches a killed host node whose container kept running: the log reads dead by pid, but the agent still writes to the workspace.
    - `runner.ts` exports `parseRunContainers(stdout): StageContainer[]`, pure: split on `\r?\n`, each non-empty line is `<runId> <name>`, split at the first space.
    - `runner.ts` exports `runningRunContainers(): StageContainer[]`: `spawnSync("docker", ["ps", "--filter", "label=ralph.run", "--format", '{{.Label "ralph.run"}} {{.Names}}'], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })`. An `error`, a non-zero status or a timeout gives `[]`.
    - `run-log.ts` exports `findRunContainer(historyDir, selfRunId, running): StageContainer | undefined`. It returns the first running container whose runId isn't `selfRunId` and has a `<runId>.jsonl` in `historyDir`. It types the container structurally, so `run-log.ts` doesn't import the runner.
    - After a `findLiveRun` miss, `loop.ts` calls `findRunContainer(historyDir, runLog.runId, runningRunContainers())`. A hit prints `[refused] run <runId> still has a running container (<name>); remove it: docker rm -f $(docker ps -aq --filter label=ralph.run=<runId>)`, appends `run.ended {refused, completedIterations: 0, blockedBy: runId}`, prunes, and resolves `"refused"`.
    - Matching is by runId from the history dir, never by path, so Windows and WSL launches share it.
    - Limits: containers of already-pruned logs aren't seen; the chown helper and containers the agent starts through docker.sock carry no label.
  - **`blockedBy`** names the run that blocked the launch: a live run, or a run whose container still runs (that run may be dead or ended).
  - **Reader rule.** The current run is the newest log that isn't refused; a refused log's `blockedBy` names the blocker. Callers retry exit 75 with jitter.
  - `runBin` has no earlier check, because a check before the file exists would reopen the check-then-create race. A `--detach` refusal therefore lands in the detach log and the jsonl.
- **Retention.** `pruneRunLogs(historyDir, selfRunId, keep = RETAIN_RUN_LOGS)` walks the logs newest first.
  - It keeps the newest `keep` (20) logs that are not refused, plus the newest refused log. Refused means the folded view ends with reason `refused`; an unreadable log counts as not refused.
  - Refused logs stay out of the 20, so a burst of refused relaunches cannot push a real run's log out.
  - It never deletes `selfRunId`'s log, even when a clock step back sorts it older.
  - It runs in two places: after the claim passes, and on each refusal path right after `run.ended refused` is appended.
  - After a passed claim, everything it deletes has ended or died. On a refusal, the blocker's log is not refused, so only 20 newer logs that aren't refused could push it out.
  - A log that can't be deleted (for example, open in a Windows reader) is left for the next run.
  - `.md` files are not touched.
- **Exit codes.**
  - `runLoop` resolves with `RunEndReason`: `no-more-tasks`, `cap`, `failed` or `refused`. It throws on errors, and signals exit from their handlers.
  - `run-bin.ts` exports `EXIT_CODES = { failed: 1, refused: 75 }` (75 is EX_TEMPFAIL, "try again later") and sets `process.exitCode`.
  - `failed` keeps its footer meaning: "the last iteration's stage exhausted its retries". `statusCounts` exposes earlier failures and `error` stages.
  - A reader trusts `run.ended.reason` over exit code 1, which a thrown error (`reason: error`) or a failed log open also gives.
- **Containers.**
  - `RunStageOptions.container?: { name, runId }`. `resolveContainerArgs(container)` returns `["--name", name, "--label", "ralph.run=<runId>"]`, placed right after `run --rm -i`.
  - The loop counts attempts itself, because `withRetries` passes none (`retry.ts:28`). The attempt number is required: `child.kill()` kills only the docker CLI (`runner.ts:738`, `:767`, `:785`), so a previous attempt's container may still exist.
  - A sanitized branch contains only `[A-Za-z0-9._-]`, which Docker accepts.
  - A name recorded in an event may never have started, for example when rendering fails before `docker run`.
  - **The runner removes what it abandons** (owner decision 10).
    - `runner.ts` exports `removeContainer(name)`: `spawn("docker", ["rm", "-f", name], { detached: true, stdio: "ignore", windowsHide: true })`, `.on("error", () => {})`, `.unref()`, all inside try/catch.
    - `streamDocker` calls it when `options.container` is set, from three places: `onAbort` (which runs synchronously from the loop's signal handler, before `process.exit`), the decoder-failure kill, and the grace-timer kill.
    - Best effort: a container the daemon creates after the rm lands is still orphaned. `run.ended aborted` does not guarantee the container is gone.
    - Apart from that race, only a killed host node still orphans a running container, and the claim's docker step catches that.
  - **No workspace label.** Path strings differ between Windows, WSL and Docker Desktop's mount form, so containers are matched by runId only. Limit: two workspaces collide on a runId only with the same second, bin and branch; `--name` then conflicts once, and the retry runs as `-a2`.
- **Markdown from events** (a separate PR after the four above).
  - `openHistory` and its running totals go away. The projection lives in a new module `history-projection.ts`, which imports `history.ts` and `run-log.ts`; that breaks the `history.ts` ↔ `run-log.ts` cycle. Its pure `historyChunk(record, viewBefore)` returns the Markdown for one record:
    - the header together with the **first `stage.started`** (a `stage.started` while `viewBefore.entries` is empty), so an in-flight run has its `.md` while stage 1 runs, as slice-cycle's "newest `.md` without a footer" rule needs (`SKILL.md:38`, `HISTORY.md:32`);
    - one entry per `stage.completed`;
    - the footer on `run.ended` only for `no-more-tasks`/`cap`/`failed`. As today, there is no footer after `aborted`/`error`/`refused`.
  - `renderHistory(records)` joins the chunks.
  - The `.md` append happens after the fsync. If it fails, warn once, mark the file as lagging, and overwrite it with `renderHistory` at run end. `recordAbort` repairs a lagging `.md` too, because the signal handler exits before `finally` runs.
  - The claim scan also repairs the `.md` of a **dead** run whose file lags the log (the crash window between the fsync and the md append).
    - It rewrites only when the rendered text is non-empty and the `.md` is missing or a strict prefix of it. A run that died before stage 1 renders nothing and gets no `.md`.
    - `run-log.ts` must not import `history-projection.ts`, so `findLiveRun` hands each dead log to an optional callback that `loop.ts` supplies.
  - Totals come from `view.entries`, and the duration runs from `run.started.at`. Two documented shifts: the header start time and the duration now include image setup, and a run aborted before stage 1 leaves no header-only `.md`.
  - `loadHistoryTail` is unchanged; it still reads `.md` only.
- **No new CLI surface.** There is no `--status` command, no env knob, no watchdog and no `stuck` flag. The reducer is not exported from the package index; the supervisor reads the file.
- **Release.**
  - The changes are `feat` commits without a `BREAKING CHANGE` footer. `release-please-config.json` has no `bump-minor-pre-major`, so a breaking footer would take `ralph-core` from 0.15.0 to 1.0.0 while `@daonhan/ralph` got only a dependency patch.
  - The exit-code commit also changes `apps/cli/README.md`, so the installed package carries a release note.
- **Documentation.**
  - `docs/ARCHITECTURE.md`, a new "Run event log" section:
    - schema v1, the reducer's stop rules, the forward-compatibility rule and the version-bump rule;
    - the liveness rules (own process, pid and node, mtime across hosts, newer schema) and the age fields;
    - the claim rules, including the docker step, `blockedBy` semantics and the refused-log reader rule;
    - the supervisor recipe: kill `started.pid` first; decide with `docker ps -q --filter label=ralph.run=<runId>`; clean up with `docker rm -f $(docker ps -aq --filter label=ralph.run=<runId>)`; silence = `now − max(lastOutputAt, stage.startedAt, retry.at + backoffMs)`; trust `run.ended.reason` over exit code 1; retry exit 75 with jitter;
    - exit codes;
    - containers: names, the label, `removeContainer`;
    - retention, refused logs excluded;
    - the documented limits: Ralph versions from before the log, containers of pruned logs, unlabelled containers (the chown helper, containers started through docker.sock), runId collisions across workspaces, `removeContainer` being best effort;
    - a PowerShell reader. It uses one rule set: stop at the first line that fails to parse, has a `seq` gap or has `v` ≠ 1. It reads with `Get-Content -Raw`, because `[IO.File]::ReadAllText` fails against node's write handle, and ages the file by `LastWriteTimeUtc`. It does not check that `at` is a string, because PowerShell 7's `ConvertFrom-Json` turns it into a `[datetime]`.
  - `CLAUDE.md` and `AGENTS.md`, identical edits: per-run files, architecture items 2, 4 and 7, and the opening-order invariant.
  - `CONTEXT.md`: the `.jsonl` run log in the read path.
  - `README.md` and `apps/cli/README.md`: exit codes and one run per workspace.
  - `SECURITY.md`: the `.jsonl` log sits in the bind mount the agent can write to, so it is advisory and not a security boundary. `inputs` and agent bodies have the same sensitivity as the `.md` they duplicate.

## Testing Decisions

- **What makes a good test here.**
  - The reducer, the liveness judgment and the exit-code map are pure; tests feed them literal records, views and probe objects.
  - The writer is tested against a real temporary directory: exclusive create, fsync on the actual platform, close on `run.ended`.
  - The loop is tested through its existing harness (mocked runner, keep-alive, notify; real git in temp repos) by reading the log back through `reduceRunLog`. That tests what a supervisor sees, not internal calls.
  - Every test that opens a log closes it before `rmSync`, because Windows refuses to delete a file with an open handle.
  - Test fixtures are built inside the tests, never committed. The repo has no `.gitattributes`, and a CRLF checkout breaks byte-exact fixtures.
  - Write and fsync failures are injected with a hoisted-flag pass-through `vi.mock("node:fs")`, armed by a predicate on the written data or a one-shot fsync flag, never by an "Nth call" count.
- **Modules under test.**
  - `run-log.ts`: new suite `run-log.test.ts`.
  - `loop.ts`: `loop.test.ts`.
  - `runner.ts`: `runner-stream.test.ts` for `onOutput` and `removeContainer`, `runner.test.ts` for `resolveContainerArgs`, and a new small `runner-containers.test.ts` for `parseRunContainers` and `runningRunContainers` with a mocked `spawnSync` (`runner.test.ts` has no module mocks and runs real git).
  - `run-bin.ts`: `run-bin.test.ts`.
  - `history.ts` and `history-projection.ts`: `history.test.ts`.
- **Cases: writer and reducer.**
  - The name, `runId` and `.gitignore`; the next second on `EEXIST`, with name order equal to run order.
  - `seq` 1..n, and the rebuilt view `toEqual` the writer's view.
  - After `run.ended`, the file does not change.
  - An empty log gives no events, an empty view and `truncated:false`.
  - Each of these stops folding and keeps the records before it: a torn tail, an unparseable interior line, a `seq` gap, `v:2`, a missing required field, `run.started` not first or repeated, a record after `run.ended`.
  - An unknown type is skipped without stopping.
  - The last retry is kept on the open stage.
  - `statusCounts` counts per status.
  - A failed fsync throws, but the record is counted: a later `run.ended` lands and the file folds to it untruncated.
  - A failed write throws, and every later append throws too.
- **Cases: liveness.**
  - `ended` wins over a live pid.
  - No `run.started` means `dead`.
  - Same host: a live node pid with a stale mtime is `live`; a gone pid with a fresh mtime is `dead`; a pid reused by another program is `dead`.
  - Own process: a probe whose `pid` equals the log's pid reads `live` when `ownsRun` is true and `dead` when it is false, without calling `isAlive` or `isNode`.
  - A first line with `v:2` is found live while its mtime is fresh and not found once `utimesSync` makes it stale.
  - A different platform, WSL distro or hostname is decided by mtime only, and the probe must not be called.
  - `pidAlive(process.pid)` and `pidIsNode(process.pid)` are true. `pidAlive` is false for 0, -1, NaN and an exited child's pid.
  - `pidIsNode` is false for a running non-node child (`ping -n 30 127.0.0.1` on win32, `sleep 30` elsewhere).
- **Cases: claim and retention.**
  - A live older run is found behind an ended one, a dead one and a torn newer log.
  - The caller's own run is never counted.
  - Two racing live logs each find the other.
  - A missing directory gives `undefined`.
  - Pruning 23 logs to 20 removes the three oldest names and leaves every `.md`.
  - 22 refused logs, 1 ended log and this run's own log keep the ended log, only the newest refused log and the own log.
  - This run's own log is never deleted, even when its name sorts oldest.
  - `findRunContainer` skips this run's own runId, skips a runId with no log, and finds a logged run's container.
- **Cases: loop.** Each is checked through the log:
  - `run.started → stage.started → stage.completed → run.ended no-more-tasks`, with the `.md` sharing the base name.
  - A skipped reviewer is a `stage.completed skipped` with no `stage.started`, then `run.ended cap`.
  - A retry then failure is `stage.retry {attempt:1, error, backoffMs:5000}`, then `stage.completed failed`, then `run.ended failed`.
  - SIGINT mid-stage: at the exit moment the log ends `stage.completed aborted` + `run.ended {aborted, SIGINT}`, and the log does not change after the mocked exit lets the loop go on.
  - SIGINT during image setup: `[run.started, run.ended aborted]` and no `.md`.
  - SIGTERM during image setup: `run.ended {aborted, SIGTERM}`.
  - An image rejection: `run.ended {error:"no image"}` and no `.md`.
  - The sandbox-install findings appear on `run.ended`.
  - Heartbeat, with fake timers: after 30 s, `[run.started, stage.started, heartbeat]` with `lastOutputAt` set from `onOutput` and `lastHeartbeatAt` 30 s later. No heartbeat after `run.ended`. A heartbeat with `null` while the image hangs; the test must settle the run so its handlers are released.
  - `runLoop` resolves `no-more-tasks`/`cap`/`failed`.
  - A live log owned by the test process itself makes `runLoop` resolve `refused` with no acquire, no image and no stage. It records `blockedBy`, prints `[refused]` and writes no `.md`.
  - A never-ended log whose pid does not exist does not block.
  - 22 ended logs plus one run leave 20 logs.
  - A refusal also prunes older refused logs.
  - A running container of another logged run (the runner mock's `runningRunContainers`, which defaults to `[]`) makes `runLoop` resolve `refused` with no acquire, no image and no stage. It records `blockedBy`, prints `[refused] run <runId> still has a running container` and writes no `.md`.
  - A container name per attempt: the attempt number increments on retry, and `stage.retry.container` names the next attempt.
  - A heartbeat fsync failure warns once, and the run resolves.
  - A `stage.started` write failure rejects with no `runStage` call.
  - A `stage.retry` write failure rejects with `runStage` called once.
  - A failed write in the signal path still exits 130 and releases the wake-lock once.
- **Cases: runner and bin.**
  - `onOutput` fires once per JSON line and not for non-JSON lines.
  - `resolveContainerArgs` returns the exact argv, or `[]`.
  - With `container` set, the grace-timer, decoder-failure and abort paths each spawn a detached `docker rm -f <name>`; without a container, no rm is spawned.
  - `parseRunContainers` handles CRLF and blank lines. `runningRunContainers` gives `[]` on a spawn error and on status 1, and the parsed list on success.
  - `EXIT_CODES` mapping: `no-more-tasks`/`cap` → no exit code, `failed` → 1, `refused` → 75. Reset `process.exitCode` in `afterEach`.
- **Cases: Markdown from events.**
  - `history.test.ts` is rewritten to feed records, keeping today's expected strings byte for byte.
  - Round trip: the `.md` on disk equals `renderHistory(reduceRunLog(jsonl).events)`.
  - Mid-stage-1, the `.md` has a header and no entry or footer.
  - A lagging `.md` of a dead run is regenerated at the next launch.
  - A run that died before stage 1 gets no `.md`.
- **Handed to review (needs Docker and a real provider):** an end-to-end run from a packed-and-installed build, from a single environment (native Windows).
  - Heartbeats appear.
  - The label filter finds the container.
  - A second launch exits 75.
  - Ctrl+C exits 130 with an aborted end.
  - After Ctrl+C or a grace-timer firing, the label filter is empty within seconds and a relaunch proceeds.
  - Killing the host node process mid-stage leaves no end record. A relaunch exits 75 naming the run's container; after `docker rm -f` a relaunch proceeds.
  - A broken `RALPH_IMAGE` with `--max-retries 0` exits 1.

## Out of Scope

- Updating the slice-cycle skill (`slice-loop.ps1`, `LOOP.md`, `PHASES.md`, `HISTORY.md`) to read the log. It lives outside this repo, and the change follows the release.
  - Interim: a one-line note in the skill, shipped with the release, says that ralph now exits 1 on a failed run and 75 on a refused launch.
- Mounting `.ralph/` read-only into the sandbox, the "controlled writes" step. It needs a check against agent commands such as `git clean -fdx` that would hit the mount.
- A `--status` command, a watchdog, a built-in `stuck` verdict, or env knobs for the heartbeat, stale window or retention.
- Pruning Markdown history.
- Exporting the reducer from `@daonhan/ralph-core`'s index.

## Further Notes

**Where the requirements came from.** The "durable state" pattern:

- history in an append-only log, never edited, and the current view derived by a reducer;
- the view is disposable and rebuilt from the log;
- the log still needs controlled writes, validation and retention;
- it needs serialized writes, a durable flush before the next action, total ordering within a run, and recovery from a torn final record.

This design maps them as follows:

- **Serialized writes:** synchronous appends in one process, plus one live run per workspace.
- **Durable flush:** `fsyncSync` before the loop acts.
- **Total ordering:** `seq`.
- **Torn record:** the reducer stops at it.
- **Validation:** the reducer's per-type field check.
- **Retention:** newest 20 not refused, plus the newest refused.
- **Controlled writes:** deferred and documented.

**Owner decisions** (2026-09-17):

1. Report ages; the reader judges "stuck".
2. The supervisor reads the jsonl directly.
3. Open the log before image setup.
4. All four extras are in scope: named containers, exit 1 on failure, one run per workspace, Markdown from events.
5. Liveness is pid first, plus the node check, with heartbeat age deciding across platforms. A refusal exits 75.
6. Minor-bump release, no breaking footer.
7. Controlled writes are a documented follow-up.
8. Keep the newest 20 `.jsonl` files (refused logs excluded).
9. The claim check also asks docker. A running container of another logged run from this workspace refuses the launch (exit 75).
10. The runner removes the containers it abandons. On abort, a decoder failure and the grace timer it fires a detached `docker rm -f <name>`. Only a killed host node still orphans a container, and decision 9 catches that.

**Review findings folded in:**

- **Plan agent:**
  - no awaits before the first stage;
  - `wx` plus a same-second collision in `loop.test.ts:831`;
  - open before `acquire()`;
  - close after `run.ended` because `process.exit` is mocked;
  - EPERM means alive;
  - WSL shares the hostname;
  - `writeFileSync(fd)` for partial writes;
  - per-attempt container names.
- **Plan-adversary (fix-first):**
  - **C1:** a header-on-first-completion would hide the in-flight `.md`; fixed by the header on the first `stage.started`.
  - **C2:** a check in `runBin` before the file exists races, and a `-2` suffix mis-sorts; fixed by the post-write claim over every log and the next-second name.
  - **W1:** heartbeat age as a same-host liveness input is both too loose and too strict; fixed by pid-first plus the node check.
  - **W2:** append failure policy.
  - **W3:** retention.
  - **W4:** shared stop-at-first-bad-line rule for both readers.
  - **W5:** a distinct refusal code and `statusCounts`.
  - **W6:** release bump.
  - **W7:** label rather than name regex, plus the documented container limits.
  - **W8:** the real await boundary and test hygiene.
- **Plan-adversary pass 2** (the documents against committed Phases 1–3, fix-first):
  - **W1:** a relaunch reusing a killed run's pid refused itself; fixed by the own-process rule.
  - **W2:** a refusal returned before pruning; fixed by refused-aware retention and a prune on refusal.
  - **W3:** a log from a newer ralph read as dead; fixed by the `v > 1` mtime peek.
  - **W4:** a killed host node's container went unnoticed; fixed by the container claim and the supervisor recipe.
  - **W5:** the dead-run `.md` repair rule; fixed by the non-empty, strict-prefix rule.
  - **W6:** a failed `stage.retry` append was recorded as a failed stage; fixed by fail-closed.
  - **N1:** the silence formula. **N2:** probe timeouts. **N3:** a workspace label, later dropped. **N4:** the PowerShell reader. **N5:** the Phase 5 greps. **N6:** `history-projection.ts`. **N7:** trust `reason` over exit 1. **N8:** the interim slice-cycle note.
- **Plan-adversary pass 3** (red-team of the pass 2 fold, fix-first):
  - **C1:** the grace timer and a decoder failure killed only the docker CLI; fixed by `removeContainer` (decision 10).
  - **W1:** `seq` advancing only after fsync poisoned the log after a failed fsync; fixed by the write/fsync split.
  - **W2/W3/S3/S4:** path strings are fragile keys, and not every container is labelled; fixed by the runId container claim with one timed `docker ps`, and the documented limits.
  - **W4:** the retry-append fix must rethrow at once, with no backoff and no failed-stage entry; fixed by `retryLogError`.
  - **W5:** no rule for adding required fields; fixed by the version-bump rule.
  - **S1:** own process by a Set of open runIds, not by pid alone. **S2:** never delete this run's own log, and prune refused logs on refusal.

**Facts checked on 2026-09-17 on the primary host** (Windows 11, Node 22, this repo at `17b0cf1`):

- A `wx` open followed by `fsyncSync` succeeds on NTFS.
- The `tasklist` CSV probe identifies the vitest worker as node and a running `ping` as not node.
- Two same-second opens yield `…101500…` and `…101501…`.
- Baseline suites: core vitest 17 files / 267 tests, of which `template-contract.test.ts > ralph-tdd names itself after its directory` fails on any CRLF checkout (pre-existing; see the CRLF memory note). Root `pnpm test` 60 tests.

**Stress test.**

- **Killer assumption:** a reader can trust "pid alive and node" to mean "that run". A different node process that reuses the pid would block relaunch until it exits. That is unlikely but possible, and the refusal message names the pid and path so a human can check.
- **Other assumptions:**
  - fsync every 30 s is cheap on local disks; network-mounted workspaces were not measured.
  - `onOutput` per stdout line has negligible cost next to the NDJSON append it accompanies.
- **Strongest counter-argument:** a lock file would serialize launches without scanning logs. But taking over a stale lock is itself racy without a compare-and-swap, and the log already carries the pid, host and ages a stale-lock decision needs.
- **This would be unnecessary if** Docker Desktop reported host paths in mounts and Ralph exited non-zero on failure. That would fix two symptoms, but still leave a hung pull and a hung stage invisible.
