# Plan: A durable per-run event log a supervisor can read

> Source PRD: [docs/prd/durable-run-log.md](../prd/durable-run-log.md)

## Architectural decisions

These durable decisions apply to every phase.

- **One new module, `packages/core/src/run-log.ts`, fully synchronous.** It owns the log format, the writer, the reducer, liveness, the claim check and retention.
  - `loop.ts` calls it; `runner.ts` and `run-bin.ts` do not import its runtime (`run-bin.ts` imports only the `RunEndReason` type).
  - `history.ts` keeps its helpers (`sanitizeBranch`, `fileTimestamp`, `currentBranch`, `headShort`, `dirtySnapshot`, the render functions, `loadHistoryTail`) and gains `historyBaseName(ts, bin, branch)`, with `historyFileName` becoming `historyBaseName(...) + ".md"`.
- **Public surface of `run-log.ts`**:

  ```ts
  export const RUN_LOG_VERSION = 1;
  export const HEARTBEAT_MS = 30_000;
  export const STALE_AFTER_MS = 5 * 60_000;
  export const RETAIN_RUN_LOGS = 20;

  export type RunEndReason =
    "no-more-tasks" | "cap" | "failed" | "aborted" | "error" | "refused";
  export type RunStarted = {
    type: "run.started";
    runId: string;
    pid: number;
    hostname: string;
    platform: string;
    wslDistro?: string;
    bin: string;
    agent: string;
    iterations: number;
    inputs: string;
    branch?: string;
    version: string;
  };
  export type StageStarted = {
    type: "stage.started";
    iteration: number;
    stageIndex: number;
    stage: string;
    logPath: string;
    container: string;
  };
  export type StageRetry = {
    type: "stage.retry";
    iteration: number;
    stage: string;
    attempt: number;
    error: string;
    backoffMs: number;
    container: string;
  };
  export type StageCompleted = { type: "stage.completed" } & StageEntry;
  export type Heartbeat = { type: "heartbeat"; lastOutputAt: string | null };
  export type RunEnded = {
    type: "run.ended";
    reason: RunEndReason;
    completedIterations: number;
    signal?: "SIGINT" | "SIGTERM";
    blockedBy?: string;
    findings?: string[];
    error?: string;
  };
  export type RunEvent =
    | RunStarted
    | StageStarted
    | StageRetry
    | StageCompleted
    | Heartbeat
    | RunEnded;
  export type RunRecord = RunEvent & { v: number; seq: number; at: string };

  export type RunView = {
    started?: RunStarted & { at: string };
    stage?: {
      iteration: number;
      index: number;
      name: string;
      startedAt: string;
      logPath: string;
      container: string;
      retry?: { attempt: number; at: string; backoffMs: number };
    };
    lastEventAt?: string;
    lastHeartbeatAt?: string;
    lastOutputAt?: string | null;
    entries: StageEntry[];
    statusCounts: Record<string, number>;
    ended?: RunEnded & { at: string };
  };

  export function emptyRunView(): RunView;
  export function applyEvent(view: RunView, record: RunRecord): RunView; // pure
  export function reduceRunLog(text: string): {
    events: RunRecord[];
    view: RunView;
    truncated: boolean;
  };

  export interface RunLog {
    readonly filePath: string;
    readonly runId: string;
    readonly view: RunView;
    append(event: RunEvent): void;
    close(): void;
  }
  export function openRunLog(opts: {
    workspaceDir: string;
    bin: string;
    started: Omit<RunStarted, "type" | "runId" | "bin" | "branch">;
    now?: Date;
  }): RunLog;

  export type Liveness = "ended" | "live" | "dead";
  export type LivenessProbe = {
    now: number;
    hostname: string;
    platform: string;
    wslDistro?: string;
    isAlive(pid: number): boolean;
    isNode(pid: number): boolean;
  };
  export function runLiveness(
    view: RunView,
    mtimeMs: number,
    probe: LivenessProbe
  ): Liveness;
  export function pidAlive(pid: number): boolean;
  export function pidIsNode(pid: number): boolean;
  export function hostProbe(): LivenessProbe;
  export type LiveRun = { runId: string; filePath: string; view: RunView };
  export function findLiveRun(
    historyDir: string,
    selfRunId: string,
    probe?: LivenessProbe
  ): LiveRun | undefined;
  export function pruneRunLogs(historyDir: string, keep?: number): void;
  ```

  The `container` field on `StageStarted`/`StageRetry`/`RunView.stage` arrives in Phase 4, `heartbeat` in Phase 2, and liveness/claim/retention plus `refused`/`blockedBy`/`statusCounts` in Phase 3. Each phase adds exactly its part.

- **File.**
  - Path: `<ws>/.ralph/history/<historyBaseName>.jsonl`, opened `openSync(path, "wx", 0o600)`.
  - On `EEXIST`, retry with the timestamp advanced one second, up to 60 tries. Never add a suffix.
  - `openRunLog` creates the directory and its `*` `.gitignore` (only when missing), then appends `run.started`. If that append throws, it closes the file and rethrows.
- **Append.**
  1. `const record = { v: 1, seq: seq + 1, at: new Date().toISOString(), ...event }`.
  2. `writeFileSync(fd, JSON.stringify(record) + "\n")`, then `fsyncSync(fd)`.
  3. Only then `seq = record.seq; view = applyEvent(view, record)`.

  Appends after close are no-ops, and `run.ended` closes the file.

- **Reducer stop rules.** Folding stops, and `truncated` is set, at the first line that has any of these problems:
  - no trailing newline;
  - not JSON, or not an object;
  - `v !== 1`;
  - `seq !== events.length + 1`;
  - non-string `at` or `type`;
  - a record after `run.ended`;
  - `(seq === 1) !== (type === "run.started")`;
  - a known type missing a required field.

  Required fields per known type:
  - `run.started`: `runId, hostname, platform, bin, agent, inputs, version` as strings, `pid, iterations` as numbers;
  - `stage.started`: `iteration, stageIndex` as numbers, `stage, logPath` (+ `container` from Phase 4) as strings;
  - `stage.retry`: `iteration, attempt, backoffMs` as numbers, `stage, error` (+ `container`) as strings;
  - `stage.completed`: `iteration, durationMs` as numbers, `stage, status, head, logPath, body` as strings;
  - `heartbeat`: `lastOutputAt` as a string or `null`;
  - `run.ended`: `reason` as a string, `completedIterations` as a number.

  Unknown types are skipped (they still consume `seq`).

- **Loop order** (`runLoop` in `loop.ts`):
  1. The `--codex-user-config` check.
  2. The version banner.
  3. `openRunLog`.
  4. (Phase 3) `findLiveRun`, returning `"refused"` on a hit, then `pruneRunLogs`.
  5. `acquire()`, the handlers, `try {` (Phase 2) heartbeat start, then `ensureImage` …

  **No `await` may be added before the first `runStage` call:** `loop.test.ts` counts two microtask turns at nine sites. `bin` in the log is the short form (`bin.replace(/^ralph-/, "")`).

- **History pairing until Phase 6.** `openHistory` gains `baseName?: string` and `loop.ts` passes `runLog.runId`, so both files share a name. The `.md` still opens after `ensureImage`.
- **Exit codes** (`run-bin.ts`). `export const EXIT_CODES: Partial<Record<RunEndReason, number>> = { failed: 1, refused: 75 };`. `runBin` sets `process.exitCode` from `await runLoop(...)`.
- **Containers.**
  - Name: `ralph-${runId}-i${iteration}-s${stageIndex}-a${attempt}`. Label: `ralph.run=${runId}`.
  - `runner.ts` exports `type StageContainer = { name: string; runId: string }` and `resolveContainerArgs(container?: StageContainer): string[]`, and `RunStageOptions` gains `container?: StageContainer` and `onOutput?: () => void`.
- **Release.** `feat(core):` / `feat(cli):` commits, **no `BREAKING CHANGE` footer** (decision 6 in the PRD). Phase 3's commit also touches `apps/cli/README.md`.
- **Constraints.**
  - Windows checkout with `core.autocrlf`: write new files LF. Build test fixtures inside tests.
  - Close every `RunLog` a test opens before `rmSync`.
  - Stage by explicit path.
  - The pre-commit hook runs Prettier; accept its reformatting.
  - Any check that needs Docker or a live provider belongs to review, not to a sandboxed build.
- **Baselines on `main` (`17b0cf1`).**
  - `pnpm -r test`: 17 files / 267 tests, of which 1 fails on CRLF checkouts (`template-contract.test.ts > ralph-tdd names itself after its directory`, pre-existing, leave it).
  - Root `pnpm test`: 60 tests.
  - These identifiers occur **0** times under `packages/core/src`, `packages/core/templates`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `SECURITY.md`, `docs/ARCHITECTURE.md` and `apps/cli/README.md`: `run-log`, `openRunLog`, `reduceRunLog`, `RunView`, `HEARTBEAT_MS`, `findLiveRun`, `pruneRunLogs`, `EXIT_CODES`, `resolveContainerArgs`, `ralph.run=`, `.jsonl`, `onOutput`.
- **Verification per phase:** `pnpm -r typecheck`, `pnpm -r test` (only the known CRLF failure may fail), root `pnpm test`.

---

## Phase 1: Every run writes a durable event log

**User stories**: 1, 2, 13

### What to build

1. **`history.ts`.** Add `historyBaseName` and `openHistory({ …, baseName? })` (uses `${baseName}.md` when given).
2. **`run-log.ts`.**
   - Types (without `container`, `heartbeat`, `refused`, `blockedBy`, `statusCounts`), `emptyRunView`, `applyEvent`, `reduceRunLog` with the stop rules, `openRunLog` with the next-second naming.
   - In `applyEvent`:
     - `run.started` sets `started`;
     - `stage.started` sets `stage`;
     - `stage.retry` sets `stage.retry` (when a stage is open);
     - `stage.completed` appends to `entries` and clears `stage`;
     - `run.ended` sets `ended` and clears `stage`;
     - every record sets `lastEventAt`.
3. **`loop.ts`.**
   - Open the log after the banner, with `started: { pid: process.pid, hostname: os.hostname(), platform: process.platform, wslDistro: process.env.WSL_DISTRO_NAME, agent, iterations, inputs, version: readCoreVersion() }`.
   - Add `recordEntry(entry)`: `runLog.append({ type: "stage.completed", ...entry })`, then `history?.appendEntry(entry)`. It replaces all three `history.appendEntry` calls and the one in the abort path.
   - After `current = {...}`, append `stage.started`.
   - In `onAttempt`, append `stage.retry` with `backoffMs: backoffFor(DEFAULT_BACKOFF_MS, attempt)`.
   - Compute `warnSandboxInstall` once per exit and pass its findings to `run.ended` (only when non-empty) and to the footer.
   - Append `run.ended` before each footer (`no-more-tasks`, and `failed`/`cap`).
   - In `catch`, append `run.ended error` (wrapped).
   - In `recordAbort(body, signal)`, record the aborted entry when a stage is open (wrapped), then `run.ended {aborted, signal}` (wrapped).
   - In `finally`, `runLog.close()`.
   - Move the `completedIterations` / `sentinelHit` / `runFailed` declarations above the handlers.

**Tests:**

- **New `__tests__/run-log.test.ts`.**
  - Name, `runId`, `.gitignore`, and a first record `{v:1, seq:1, type:"run.started", bin:"afk"}`.
  - Two opens at the same `now` produce `…101500-afk.jsonl` and `…101501-afk.jsonl`.
  - `seq` runs `[1,2,3]`, and the view rebuilt from disk `toEqual`s `log.view`.
  - The file is unchanged by an append after `run.ended`.
  - An empty log gives `{events:[], view:{entries:[]}, truncated:false}`.
  - Folding stops, with the earlier records kept, at: a torn tail, a bad interior line, a seq gap, `v:2`, a missing field, `run.started` not first or repeated, and a record after `run.ended`.
  - An unknown type is skipped.
  - The last retry is kept on the open stage.
  - A five-record log round-trips through the writer.
  - `afterEach` closes every opened log before `rmSync`.
- **`__tests__/loop.test.ts`.**
  - Add `historyFiles(ws, ext)` and `readRunLog(ws)` helpers.
  - Change the two `.ralph`-absent assertions (`:616`, `:855`) to "no `.md`, and the log is `[run.started, run.ended]` with `aborted`/`SIGINT` and `error`/`no image` respectively".
  - Add log assertions to the SIGINT mid-stage test: at the exit moment the log is `[run.started, stage.started, stage.completed(aborted, dirty), run.ended(aborted, SIGINT)]`, and after `await loop` it `toEqual`s that snapshot.
  - Add log assertions to the SIGTERM-during-image test: `run.ended {aborted, SIGTERM}`.
  - New test for no-more-tasks: sequence, `started` fields, the `.md` named `${runId}.md`.
  - New test for skipped reviewer then cap.
  - New test for retry then failed: `stage.retry {attempt:1, error:"first boom", backoffMs:5000}`.
  - New test for findings on `run.ended`.

### Acceptance criteria

- [ ] `test -f packages/core/src/run-log.ts && test -f packages/core/src/__tests__/run-log.test.ts`.
- [ ] `grep -c "export function openRunLog\|export function reduceRunLog\|export function applyEvent" packages/core/src/run-log.ts` reads 3; `grep -c "fsyncSync(fd)" packages/core/src/run-log.ts` reads 1; `grep -c '"wx"' packages/core/src/run-log.ts` reads 1.
- [ ] `grep -c "async \|await [A-Za-z(]" packages/core/src/run-log.ts` reads 0 (no asynchronous code in the module).
- [ ] In `loop.ts`, `openRunLog(` appears before `acquire(` (`grep -n "openRunLog(\|acquire({" packages/core/src/loop.ts` lists `openRunLog` first), and `grep -c 'type: "run.ended"' packages/core/src/loop.ts` reads ≥ 4 (no-more-tasks, cap/failed, error, aborted).
- [ ] `grep -c "history.appendEntry\|history?.appendEntry" packages/core/src/loop.ts` reads 1 (inside `recordEntry` only).
- [ ] `grep -c 'existsSync(join(dirs.workspaceDir, ".ralph"))' packages/core/src/__tests__/loop.test.ts` reads 0.
- [ ] `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/run-log.test.ts src/__tests__/loop.test.ts src/__tests__/history.test.ts` is green, with `run-log.test.ts` ≥ 14 tests.
- [ ] Verification gate green (only the known CRLF failure).

---

## Phase 2: A heartbeat reports the agent's last output

**User stories**: 2, 3, 4

### What to build

1. **`runner.ts`.** `RunStageOptions.onOutput?: () => void`, called in `streamDocker`'s `rl.on("line")` handler right after the `settled || !line.startsWith("{")` guard, before the NDJSON append.
2. **`run-log.ts`.** `Heartbeat` in the union, `HEARTBEAT_MS`. The view fields `lastHeartbeatAt` / `lastOutputAt`, set on `heartbeat`. The validator's `string-or-null` kind.
3. **`loop.ts`.**
   - Declare `let lastOutputAt: number | undefined`, `heartbeatWarned`, and `heartbeat` before `try`.
   - The first statement in `try` is `heartbeat = setInterval(() => { try { runLog.append({ type: "heartbeat", lastOutputAt: … ISO or null }) } catch (err) { warn once: "[warning] run log heartbeat failed: <msg>" } }, HEARTBEAT_MS); heartbeat.unref?.();`.
   - Pass `onOutput: () => { lastOutputAt = Date.now(); }` to `runStage`.
   - In `finally`, `clearInterval(heartbeat)` before `runLog.close()`.

**Tests:**

- **`runner-stream.test.ts`.** One run writes three JSON records and one non-JSON line; `onOutput` is called 3 times.
- **`loop.test.ts`.**
  - With fake timers at `2026-09-17T10:00:00Z`, `runStage` calls `options.onOutput()` and stays pending. After `advanceTimersByTimeAsync(30_000)` the log is `[run.started, stage.started, heartbeat]` with `lastOutputAt` `…10:00:00.000Z` and `lastHeartbeatAt` `…10:00:30.000Z`. Then resolve the stage, `await loop`, advance 60 s more: the last event is `run.ended` and there is exactly one heartbeat.
  - With `ensureImage` pending, after 30 s the log is `[run.started, heartbeat]` with `lastOutputAt: null`. Then reject the image promise and `await expect(loop).rejects`, so no handler or timer leaks into later tests.
- **`run-log.test.ts`.** A heartbeat with a non-string, non-null `lastOutputAt` stops folding.

### Acceptance criteria

- [ ] `grep -c "onOutput" packages/core/src/runner.ts` reads 2 (option + call); `grep -c "HEARTBEAT_MS" packages/core/src/loop.ts` reads ≥ 1; `grep -c "clearInterval(heartbeat)" packages/core/src/loop.ts` reads 1; `grep -c "unref" packages/core/src/loop.ts` reads ≥ 1.
- [ ] `grep -c 'type: "heartbeat"' packages/core/src/loop.ts` reads 1.
- [ ] Tests exist: `grep -c "onOutput" packages/core/src/__tests__/runner-stream.test.ts` reads ≥ 1; `grep -c '"heartbeat"' packages/core/src/__tests__/loop.test.ts` reads ≥ 2.
- [ ] Verification gate green.

---

## Phase 3: One live run per workspace, exit codes, retention

**User stories**: 5, 6, 8, 9, 10, 11

### What to build

1. **`run-log.ts`.**
   - Add `"refused"` to `RunEndReason`, `blockedBy?` to `RunEnded`, and `statusCounts` to the view (incremented on `stage.completed`; `emptyRunView` returns `{ entries: [], statusCounts: {} }`).
   - Add `STALE_AFTER_MS`, `Liveness`, `LivenessProbe`, `runLiveness`, `pidAlive`, `pidIsNode`, `hostProbe`, `LiveRun`, `findLiveRun`, `RETAIN_RUN_LOGS`, `pruneRunLogs`, exactly as the PRD's Liveness / Claim / Retention decisions specify.
   - `pidIsNode` catch branch: Linux returns `e.code !== "ENOENT"`, non-win32 returns `e.status !== 1`, win32 returns `true`. A win32 output with no row starting with `"` returns `false`.
2. **`loop.ts`.**
   - `runLoop` returns `Promise<RunEndReason>`, with a doc comment naming the resolved reasons.
   - Right after `openRunLog`:

     ```ts
     const historyDir = dirname(runLog.filePath);
     const blocker = findLiveRun(historyDir, runLog.runId);
     if (blocker) {
       /* print [refused] line with pid, hostname, started at, formatDuration(idle), path */
       runLog.append({
         type: "run.ended",
         reason: "refused",
         completedIterations: 0,
         blockedBy: blocker.runId,
       });
       return "refused";
     }
     pruneRunLogs(historyDir);
     ```

   - `return "no-more-tasks"` at the sentinel; `return reason` after the cap/failed footer.
3. **`run-bin.ts`.** `EXIT_CODES`, `const reason = await runLoop(...)`, and `if (EXIT_CODES[reason] !== undefined) process.exitCode = EXIT_CODES[reason]`.
4. **`apps/cli/README.md`.** A paragraph after the history paragraph covering:
   - the per-run event log (newest 20 kept);
   - one live run per workspace (exit 75);
   - exit 1 when the last iteration failed, and 0 for `no-more-tasks`/cap, 130 for Ctrl+C;
   - a link to `docs/ARCHITECTURE.md#run-event-log`.

**Tests:**

- **`run-log.test.ts`.**
  - `statusCounts` gives `{ok:2, failed:1}`.
  - `runLiveness` table:
    - `ended` wins;
    - no `started` means `dead`;
    - same host with a live pid and a stale mtime is `live`;
    - same host with a gone pid and a fresh mtime is `dead`;
    - same host with `isNode: () => false` is `dead`;
    - another platform/WSL distro/hostname is decided by mtime against `STALE_AFTER_MS`, with a probe whose `isAlive` throws if called.
  - `pidAlive(process.pid)` / `pidIsNode(process.pid)` are true; `pidAlive(0|-1|NaN)` is false.
  - An exited child's pid is not alive.
  - A running `ping -n 30 127.0.0.1` (win32) or `sleep 30` is alive but not node (kill it in `finally`).
  - `findLiveRun`:
    - a live older run behind an ended, a dead and a torn (`"{"`) newer log;
    - self never counted;
    - two racing live logs find each other;
    - a missing dir gives `undefined`.
  - `pruneRunLogs(dir, 20)` on 23 `.jsonl` + 23 `.md` keeps the newest 20 `.jsonl` and all 23 `.md`.
- **`loop.test.ts`.**
  - `runLoop` resolves `no-more-tasks` / `cap` / `failed`.
  - An open log with `pid: process.pid` and this host's identity makes `runLoop` resolve `refused`. Assert that `acquire`, `ensureImage` and `runStage` were not called, that stderr contains `[refused] another ralph run is live in this workspace: pid <process.pid> on <hostname()>`, that the new log is `[run.started, run.ended{refused, blockedBy}]`, and that there is no `.md`. Close the live log in `finally`.
  - A closed, never-ended log with `pid: 2**31 - 1` does not block.
  - 22 ended logs plus a run leave 20 `.jsonl`, the oldest remaining being the 3rd.
- **`run-bin.test.ts`.** `it.each` over `no-more-tasks → undefined`, `cap → undefined`, `failed → 1`, `refused → 75`. `afterEach` sets `process.exitCode = undefined`.

### Acceptance criteria

- [ ] `grep -c "export function findLiveRun\|export function pruneRunLogs\|export function runLiveness\|export function pidIsNode\|export function pidAlive" packages/core/src/run-log.ts` reads 5.
- [ ] `grep -c "tasklist" packages/core/src/run-log.ts` reads 1; `grep -c "/proc/" packages/core/src/run-log.ts` reads 1; `grep -c '"EPERM"' packages/core/src/run-log.ts` reads 1.
- [ ] `grep -c "findLiveRun(" packages/core/src/loop.ts` reads 1 and `grep -c "findLiveRun\|pruneRunLogs" packages/core/src/run-bin.ts` reads 0 (no pre-write check).
- [ ] `grep -c "Promise<RunEndReason>" packages/core/src/loop.ts` reads 1; `grep -c "refused: 75" packages/core/src/run-bin.ts` reads 1; `grep -c "failed: 1" packages/core/src/run-bin.ts` reads 1.
- [ ] `grep -c "75" apps/cli/README.md` reads ≥ 1.
- [ ] `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/run-log.test.ts src/__tests__/loop.test.ts src/__tests__/run-bin.test.ts` green; `run-log.test.ts` ≥ 30 tests.
- [ ] The commit subject starts `feat(cli):` and the message has no `BREAKING CHANGE` line.
- [ ] Verification gate green.

---

## Phase 4: Each stage attempt runs in a named, labelled container

**User stories**: 7

### What to build

1. **`runner.ts`.**
   - `StageContainer`, `RunStageOptions.container?`.
   - `export function resolveContainerArgs(container?: StageContainer): string[]`, returning `[]` without a container, else `["--name", name, "--label", "ralph.run=" + runId]`, with a doc comment giving the label filter recipe.
   - In `runStage`, spread it right after `"run", "--rm", "-i"`.
2. **`run-log.ts`.** `container: string` on `StageStarted`, `StageRetry` and `RunView.stage` (required by the validator). `stage.retry` updates `stage.container` to the next attempt's name.
3. **`loop.ts`.**
   - `const containerName = (i, s, attempt) => \`ralph-${runLog.runId}-i${i}-s${s}-a${attempt}\``.
   - Per stage, `let attempt = 0`. `stage.started` carries `containerName(i, s, 1)`.
   - Inside the retried closure, `attempt++` before rendering, and pass `container: { name: containerName(i, s, attempt), runId: runLog.runId }` to `runStage`.
   - `stage.retry` carries `containerName(i, s, attempt + 1)`, where `attempt` is `onAttempt`'s failed attempt.

**Tests:**

- **`runner.test.ts`.** `resolveContainerArgs({ name: "ralph-2026-09-17-101500-ghafk-feat.x-i2-s1-a3", runId: "2026-09-17-101500-ghafk-feat.x" })` returns the exact four-element argv; `resolveContainerArgs()` returns `[]`.
- **`loop.test.ts`.**
  - Retry-then-success with fake timers: `runStage` call 1 gets `container.name` ending `-i1-s0-a1`, and call 2 gets `-a2`. The log's `stage.started.container` ends `-a1`, `stage.retry.container` ends `-a2`, and both carry `runId` = the log's `runId`.
  - A reviewer stage (index 1) gets `-s1-`.
- **`run-log.test.ts`.** A `stage.started` without `container` stops folding. Update the hand-built `stageStarted` fixtures to carry one.

### Acceptance criteria

- [ ] `grep -c "export function resolveContainerArgs" packages/core/src/runner.ts` reads 1; `grep -c "ralph.run=" packages/core/src/runner.ts` reads ≥ 1; `grep -c "resolveContainerArgs(options.container)" packages/core/src/runner.ts` reads 1.
- [ ] `grep -c -- "-a\${attempt}" packages/core/src/loop.ts` reads 1.
- [ ] `grep -c "resolveContainerArgs" packages/core/src/__tests__/runner.test.ts` reads ≥ 2.
- [ ] Verification gate green.

### Handed to review (needs Docker)

`ralph-ghafk 1` in a scratch repo, then:

- `docker ps --filter label=ralph.run=<runId> --format "{{.Names}}"` prints the `…-i1-s0-a1` name while stage 1 runs;
- `docker inspect` shows the label.

---

## Phase 5: Document the run event log (closes PR A)

**User stories**: 1, 3, 5, 7, 8, 11

### What to build

Docs only.

- **`docs/ARCHITECTURE.md`.** A new `## Run event log` section (anchor `#run-event-log`) containing:
  - the file and naming (the next-second rule and why);
  - the opening order;
  - the event table (v1);
  - the reducer stop rules and the forward-compatibility rule;
  - the heartbeat and `lastOutputAt`;
  - the append failure policy;
  - liveness (same host: pid + node; otherwise mtime < 5 min);
  - the claim check and its race argument;
  - exit codes;
  - containers (name, label, the `docker ps -q --filter label=ralph.run=<runId>` recipe, the two limits);
  - retention;
  - the supervisor status table from the PRD;
  - a PowerShell reader that stops at the first line that fails to parse or breaks `seq`.

  Also add `run-log.ts` to the module map, `--name/--label` to the `docker run` argv shape, and the `ralph.run` label beside the `ralph.kind` volume labels.

- **`CLAUDE.md` and `AGENTS.md`** (identical edits):
  - item 2 (`loop.ts`): the log opens before image setup; the claim check; the end reason;
  - item 4 (`runner.ts`): `container` and `onOutput`;
  - item 7 (`history.ts`): the `.jsonl` beside the `.md`, the newest 20 kept;
  - "Per-run files": the `.jsonl`;
  - the "image failure" wording becomes "no `.md`";
  - a convention bullet: **"The run log is the run's durable state."** Only `loop.ts` appends; records are fsynced before the loop acts; no `await` before the first stage.
- **`CONTEXT.md`.** The read path mentions `run-log.ts`.
- **`README.md`.** In "Running AFK": exit codes (0 / 1 / 75 / 130 / 143), one run per workspace, and where the log lives.
- **`SECURITY.md`.** The log is advisory, not a security boundary (agent-writable bind mount); `inputs`/bodies have the same sensitivity as the `.md`.

### Acceptance criteria

- [ ] `grep -c "^## Run event log" docs/ARCHITECTURE.md` reads 1; `grep -c "ralph.run=" docs/ARCHITECTURE.md` reads ≥ 2; `grep -c "STALE_AFTER_MS\|5 min" docs/ARCHITECTURE.md` reads ≥ 1; `grep -c "ConvertFrom-Json" docs/ARCHITECTURE.md` reads ≥ 1.
- [ ] `for f in README.md CLAUDE.md AGENTS.md CONTEXT.md SECURITY.md docs/ARCHITECTURE.md; do grep -c "\.jsonl" $f; done` prints ≥ 1 for every file.
- [ ] `grep -c '`75`' README.md` reads ≥ 1 and `grep -c '`75`' apps/cli/README.md` reads ≥ 1.
- [ ] Twins: `diff <(grep -n "jsonl\|run-log\|ralph.run" CLAUDE.md | cut -d: -f2-) <(grep -n "jsonl\|run-log\|ralph.run" AGENTS.md | cut -d: -f2-)` prints nothing.
- [ ] `git diff --stat main -- packages/core/src` equals the stat after Phase 4 (docs-only phase).
- [ ] Root `pnpm test` green.

---

## Phase 6: The Markdown history is a projection of the log (PR B)

**User stories**: 12

### What to build

1. **`history.ts`.**
   - Remove `openHistory`, `HistoryWriter` and the running totals.
   - Add a pure `historyChunk(record: RunRecord, before: RunView): string`, where `before` is the view **before** the record:
     - on `stage.started` with `before.entries.length === 0`, return the header: `renderHeader(started.bin, displayTimestamp(started.at), started.branch, started.iterations, started.inputs)`. That is exactly the run's first `stage.started`: every later one follows a `stage.completed`, and retries emit no `stage.started`.
     - on `stage.completed`, return `renderEntry(started.iterations, entry)`. An `aborted` entry always follows its `stage.started`, and a `skipped` one never comes first, because the gate always runs.
     - on `run.ended` with reason `no-more-tasks`/`cap`/`failed`, return `renderFooter(completedIterations, started.iterations, reason, totals, findings)`. The totals come from `before.entries`, with duration `record.at − started.at`.
     - otherwise return `""`.
   - `renderHistory(records: RunRecord[]): string` folds with `applyEvent`, calls `historyChunk` with each record's before-view, and joins the chunks.
2. **`loop.ts`.**
   - `RunLog.append` returns the written `RunRecord` (or `undefined` once closed), and `RunLog` gains `readonly records: RunRecord[]`.
   - Around each append, capture `const before = runLog.view`. After a successful append, append `historyChunk(record, before)` to `<historyDir>/<runId>.md` when non-empty.
   - An md append failure warns once (`[warning] history file write failed: <msg>`) and sets `mdLagging`.
   - In `finally`, if `mdLagging`, `writeFileSync(mdPath, renderHistory(runLog.records))` (wrapped).
   - `printRunSummary` takes its totals from the view.
3. **`findLiveRun` scan.** For each **dead** log whose `.md` is missing or differs from `renderHistory(events)`, rewrite the `.md` (wrapped).
4. **Documentation.**
   - `CLAUDE.md` / `AGENTS.md` item 7 and `docs/ARCHITECTURE.md`: the `.md` is a projection of the log.
   - The two documented shifts: start/duration include image setup; no header-only `.md` after an abort before stage 1.

**Tests:**

- **`history.test.ts`.** Rewrite the `openHistory` describe into `historyChunk`/`renderHistory`, fed with records built through a helper. Every expected string from today's tests stays byte-identical:
  - the `# ralph-afk · 2026-09-08 12:34:56Z · 3 iterations` header;
  - the entry lines;
  - the footer regexes;
  - totals `2 stages (1 skipped) · $1.50 · 3.0k in / 1.5k out`;
  - the sandbox-install suffix;
  - the retries/attempts/dirty order;
  - omitted fields.
- **`loop.test.ts`.**
  - Round trip: after a two-stage cap run, the `.md` on disk equals `renderHistory(readRunLog(ws).events)`.
  - While stage 1 is pending, the `.md` exists with the header and no `## iter`.
  - The existing SIGINT test still sees the aborted entry and no footer.
  - A dead log with no `.md` gets its `.md` regenerated when the next run starts.

### Acceptance criteria

- [ ] `grep -c "export function openHistory" packages/core/src/history.ts` reads 0; `grep -c "export function historyChunk\|export function renderHistory" packages/core/src/history.ts` reads 2.
- [ ] `grep -r "openHistory" packages/core/src | wc -l` reads 0 (tests included).
- [ ] Every expected-string literal in `git show main:packages/core/src/__tests__/history.test.ts` that starts with `"## iter`, `"# ralph-`, `"log: ` or `/^--- ended` still occurs in the new `history.test.ts`.
- [ ] `grep -c "renderHistory(" packages/core/src/__tests__/loop.test.ts` reads ≥ 1.
- [ ] Verification gate green.

### Handed to review (needs Docker)

A real `ralph-ghafk 2` run:

- the `.md` appears when stage 1 starts;
- at the end, its content equals `renderHistory` of the `.jsonl` (checked with a one-off `node -e` that imports the built `dist/run-log.js` and `dist/history.js`);
- slice-cycle's skim regex from `HISTORY.md` still matches the headers and footer.

---

## Slice mapping

**PR A:** Phases 1 → 2 → 3 → 4 → 5, one commit each, in dependency order.

- Phase 3's claim check needs Phase 1's log.
- Phase 4's `container` extends Phase 1's `stage.*` events.
- Phase 5 documents 1–4.

**PR B:** Phase 6, after PR A merges. It changes the Markdown writer that slice-cycle reads, so it ships separately.

**Follow-ups outside this repo** (after release): update slice-cycle's `slice-loop.ps1` and `LOOP.md`, `PHASES.md` and `HISTORY.md` to read the jsonl, stop containers by label, and trust the exit code.
