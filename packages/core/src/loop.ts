import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, posix } from "node:path";

import {
  CODEX_USER_CONFIG_REQUIRES_CODEX,
  type AgentName,
  type StageMeta,
} from "./agents/index.js";
import { readCoreVersion } from "./cli-help.js";
import {
  dirtySnapshot,
  formatDuration,
  headShort,
  loadHistoryTail,
  openHistory,
  renderRunTotals,
  type HistoryWriter,
  type StageEntry,
} from "./history.js";
import { detectSandboxInstall } from "./host-check.js";
import { acquire, type Releaser } from "./keepalive.js";
import { notifyComplete, notifyError } from "./notify.js";
import { renderTemplate } from "./render.js";
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_RETRIES,
  backoffFor,
  withRetries,
} from "./retry.js";
import {
  ensureImage,
  runStage,
  runningRunContainers,
  stageLogPath,
} from "./runner.js";
import {
  HEARTBEAT_MS,
  findLiveRun,
  findRunContainer,
  openRunLog,
  pruneRunLogs,
  type RunEndReason,
} from "./run-log.js";
import {
  USE_COLOR,
  dim,
  bold,
  red,
  greenOut,
  redOut,
  boldOut,
  dimOut,
  SYM,
  SYM_OUT,
} from "./stream-render.js";
import type { Stage } from "./stages.js";

// The agent emits this literal when there is no more work; the same string is
// mirrored in the playbook templates (prompt.md / ghprompt.md) that instruct it.
const SENTINEL = "<promise>NO MORE TASKS</promise>";

/**
 * The gate fires on an emission, not on a mention: the sentinel must stand on a
 * line of its own (surrounding whitespace and a wrapping pair of backticks
 * allowed). The playbooks put the literal in the agent's context every
 * iteration, so a closing sentence naming its own stop condition is ordinary
 * prose and must not end the run.
 */
export function hasSentinel(text: string): boolean {
  return /^\s*`?<promise>NO MORE TASKS<\/promise>`?\s*$/m.test(text);
}

// Reviewer verdicts (review.md). Neither tag + a moved HEAD ⇒ the reviewer
// committed a fix; neither tag + unchanged HEAD ⇒ a plain ok.
const REVIEW_OK = "<review>OK</review>";
const REVIEW_SKIP = "<review>SKIP</review>";

/**
 * The status recorded for one completed stage. A provider error (`meta.isError`
 * or an `apiErrorStatus`) wins over any text-derived status, so a rate-limited
 * `429` turn is recorded as `error` instead of a false success. The gate stage
 * (index 0) is judged by the completion sentinel; every later stage is the
 * reviewer, judged by its `<review>` tag or, absent a tag, by whether it moved
 * HEAD (a `review-fix` commit).
 */
export function deriveStatus(args: {
  isGate: boolean;
  text: string;
  meta: StageMeta;
  headBefore: string;
  headAfter: string;
}): string {
  if (args.meta.isError === true || args.meta.apiErrorStatus !== undefined) {
    return "error";
  }
  if (args.isGate) {
    return hasSentinel(args.text) ? "no-more-tasks" : "ok";
  }
  if (args.text.includes(REVIEW_OK)) return "review-ok";
  if (args.text.includes(REVIEW_SKIP)) return "review-skip";
  if (args.headAfter !== args.headBefore) return "review-fix";
  return "ok";
}

/**
 * The host check, run at each footer write: when the sandbox rewrote the
 * bind-mounted `node_modules`, name the fingerprints on stderr (plain text, the
 * `[failure]` line's style) so the user reinstalls before the next host command
 * fails. Returns the findings for the footer.
 */
function warnSandboxInstall(workspaceDir: string): string[] {
  const findings = detectSandboxInstall(workspaceDir);
  if (findings.length > 0) {
    const lines = [
      "[warning] sandbox install rewrote the host node_modules:",
      ...findings.map((f) => `  - ${f}`),
      "  repair on the host: delete node_modules/ and .pnpm-store/, then run your install command",
    ];
    process.stderr.write(`${lines.join("\n")}\n`);
  }
  return findings;
}

/**
 * The one stdout line every non-signal exit ends with, printed right after the
 * matching footer so the terminal and the history file carry the same totals.
 * The marker is red for a `failed` run, green for `no-more-tasks` / `cap`.
 */
function printRunSummary(
  history: HistoryWriter,
  reason: string,
  completed: number,
  iterations: number
): void {
  const marker =
    reason === "failed" ? redOut(SYM_OUT.bullet) : greenOut(SYM_OUT.bullet);
  const tail = ` \u00b7 ${reason} \u00b7 ${completed}/${iterations} iterations${renderRunTotals(
    history.runSummary()
  )}`;
  process.stdout.write(`${marker} ${boldOut("Ralph ended")}${dimOut(tail)}\n`);
}

export type LoopOptions = {
  // First stage is the gate: its result is checked for the completion sentinel.
  // Later stages run only when the gate moved HEAD; a gate that committed
  // nothing leaves them nothing to work on, so each is recorded as `skipped`
  // and no container starts.
  stages: [Stage, ...Stage[]];
  inputs: string;
  iterations: number;
  /** Docker `build` fallback context (must contain a Dockerfile). */
  ralphDir: string;
  /** Host repo bind-mounted into the sandbox at /home/agent/workspace. */
  workspaceDir: string;
  /** Installed @daonhan/ralph-core dir; stage templates are read from <packageDir>/templates. */
  packageDir: string;
  /** When true, skip OS wake-lock acquisition. Default: false. */
  noKeepAlive?: boolean;
  /** Per-stage retry budget. Default: 3. Set to 0 to disable retries. */
  maxRetries?: number;
  /** When true, fire OS notification + bell on loop terminal events. Default: false. */
  notify?: boolean;
  /** Bin name for the init-time version banner (e.g. "ralph-afk"). */
  bin?: string;
  /** CLI version for the init-time version banner. */
  cliVersion?: string;
  /** In-container coding agent. Default: Claude. */
  agent?: AgentName;
  /** When true, Codex loads ~/.codex/config.toml. Default: false. */
  codexUserConfig?: boolean;
};

/**
 * Drive the stage chain and resolve with how the run ended: `no-more-tasks`,
 * `cap`, `failed`, or `refused` when another run of this workspace is still
 * live. A thrown error rejects; a signal exits the process from its handler.
 */
export async function runLoop(opts: LoopOptions): Promise<RunEndReason> {
  const {
    stages,
    inputs,
    iterations,
    ralphDir,
    workspaceDir,
    packageDir,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    notify = false,
    bin = "ralph",
    cliVersion = "?",
    agent = "claude",
    codexUserConfig = false,
  } = opts;

  if (codexUserConfig && agent !== "codex") {
    throw new Error(CODEX_USER_CONFIG_REQUIRES_CODEX);
  }

  const coreVersion = readCoreVersion();
  const versionLine = `${bin} ${cliVersion} (core ${coreVersion})`;
  process.stderr.write(
    `${USE_COLOR ? `${dim("━━━")} ${bold(versionLine)} ${dim("━━━")}` : `== ${versionLine} ==`}\n`
  );

  // The run's event log opens first — before the wake-lock, the signal handlers
  // and image setup — so a hung pull is visible and a failed open leaks nothing.
  // `bin` arrives as "ralph-afk" / "ralph-ghafk"; the run files use the short
  // "afk" / "ghafk" form.
  const shortBin = bin.replace(/^ralph-/, "");
  const runLog = openRunLog({
    workspaceDir,
    bin: shortBin,
    started: {
      pid: process.pid,
      hostname: hostname(),
      platform: process.platform,
      wslDistro: process.env.WSL_DISTRO_NAME,
      agent,
      iterations,
      inputs,
      version: coreVersion,
    },
  });

  // One run per workspace. The check runs after this run's own run.started is
  // on disk, so two launches racing each other both refuse rather than both
  // proceed. Nothing has been acquired yet, so a refusal just ends the log —
  // and prunes, so a supervisor retrying exit 75 leaves one refused log behind.
  const historyDir = dirname(runLog.filePath);
  // One container name per stage attempt: a killed client can leave the previous
  // attempt's container behind, so a retry must not reuse its name.
  const containerName = (i: number, s: number, attempt: number): string =>
    `ralph-${runLog.runId}-i${i}-s${s}-a${attempt}`;
  const refuse = (message: string, blockedBy: string): "refused" => {
    process.stderr.write(`[refused] ${message}\n`);
    try {
      runLog.append({
        type: "run.ended",
        reason: "refused",
        completedIterations: 0,
        blockedBy,
      });
    } finally {
      // A failed write leaves the log open, and this process would go on
      // reading the unended log as a run it still owns, refusing every launch.
      runLog.close();
    }
    pruneRunLogs(historyDir, runLog.runId);
    return "refused";
  };
  const blocker = findLiveRun(historyDir, runLog.runId);
  if (blocker) {
    const started = blocker.view.started;
    const who = started
      ? `pid ${started.pid} on ${started.hostname}, started ${started.at}, last event ${formatDuration(
          Date.now() - Date.parse(blocker.view.lastEventAt ?? started.at)
        )} ago`
      : "written by a newer ralph";
    return refuse(
      `another ralph run is live in this workspace: ${who} (${blocker.filePath})`,
      blocker.runId
    );
  }
  // A killed host process leaves its container running, and committing: the
  // workspace is not free until that container stops too.
  const orphan = findRunContainer(
    historyDir,
    runLog.runId,
    runningRunContainers()
  );
  if (orphan) {
    return refuse(
      `run ${orphan.runId} still has a running container (${orphan.name}); remove it: docker rm -f $(docker ps -aq --filter label=ralph.run=${orphan.runId})`,
      orphan.runId
    );
  }
  pruneRunLogs(historyDir, runLog.runId);

  const releaser: Releaser = noKeepAlive
    ? { release: () => {} }
    : acquire({ reason: `${bin} loop` });
  const stageAbort = new AbortController();

  // Single release path: signal handlers and the finally below all funnel
  // through releaseOnce so the wake-lock child is killed exactly once.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaser.release();
  };
  const abortActiveStage = (): void => {
    if (!stageAbort.signal.aborted) stageAbort.abort();
  };

  let completedIterations = 0;
  let sentinelHit = false;
  // Whether the last iteration ended in a stage failure; decides the footer
  // reason (`failed` vs `cap`). Reset at the start of every iteration.
  let runFailed = false;

  // The history writer (opened after ensureImage) and the running stage's
  // `current` slot, both read by the signal handlers. `current` is set at each
  // stage start and cleared once that stage's own entry is written; an empty
  // slot — between stages, or before the image is ready — means a signal records
  // no entry. Either way the log gets `run.ended aborted`; in the history file
  // the `aborted` entry is the terminal marker, since the handler exits the
  // process directly and no footer follows.
  let history: HistoryWriter | undefined;
  let current:
    | { iteration: number; stage: string; startedAt: number; logPath: string }
    | undefined;
  // One completed stage, to the log first (fsynced) and then the history file.
  const recordEntry = (entry: StageEntry): void => {
    runLog.append({ type: "stage.completed", ...entry });
    history?.appendEntry(entry);
  };
  const recordAbort = (body: string, signal: "SIGINT" | "SIGTERM"): void => {
    if (current) {
      try {
        recordEntry({
          iteration: current.iteration,
          stage: current.stage,
          status: "aborted",
          durationMs: Date.now() - current.startedAt,
          head: headShort(workspaceDir),
          logPath: current.logPath,
          body,
          dirty: dirtySnapshot(workspaceDir),
        });
      } catch {
        // History may be unwritable; never block release + exit on the entry.
      }
      current = undefined;
    }
    try {
      runLog.append({
        type: "run.ended",
        reason: "aborted",
        completedIterations,
        signal,
      });
    } catch {
      // Same: the exit code still reports the signal.
    }
  };
  // A run that ends by itself: the host check, then `run.ended` to the log
  // (fsynced) before the history footer and the summary line.
  const endRun = (
    writer: HistoryWriter,
    reason: RunEndReason
  ): RunEndReason => {
    const findings = warnSandboxInstall(workspaceDir);
    runLog.append({
      type: "run.ended",
      reason,
      completedIterations,
      findings: findings.length ? findings : undefined,
    });
    writer.appendFooter(completedIterations, reason, findings);
    printRunSummary(writer, reason, completedIterations, iterations);
    return reason;
  };

  const onSigint = (): void => {
    abortActiveStage();
    recordAbort("Interrupted (SIGINT).", "SIGINT");
    if (notify) notifyError("interrupted (SIGINT)");
    releaseOnce();
    process.exit(130);
  };
  const onSigterm = (): void => {
    abortActiveStage();
    recordAbort("Terminated (SIGTERM).", "SIGTERM");
    if (notify) notifyError("terminated (SIGTERM)");
    releaseOnce();
    process.exit(143);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // Liveness for whoever watches the log: a heartbeat every HEARTBEAT_MS
  // carrying when the agent last wrote to stdout, so a supervisor can age a
  // silent stage. Ralph only reports the ages; judging "stuck" is the reader's.
  // A failed heartbeat write warns once and never ends the run.
  let lastOutputAt: number | undefined;
  let heartbeatWarned = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  try {
    heartbeat = setInterval(() => {
      try {
        runLog.append({
          type: "heartbeat",
          lastOutputAt:
            lastOutputAt === undefined
              ? null
              : new Date(lastOutputAt).toISOString(),
        });
      } catch (err) {
        if (heartbeatWarned) return;
        heartbeatWarned = true;
        process.stderr.write(
          `[warning] run log heartbeat failed: ${(err as Error).message}\n`
        );
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    await ensureImage(ralphDir, { signal: stageAbort.signal });

    // History opens only after the image is confirmed: an image failure must
    // leave no history file behind (the event log records it instead).
    history = openHistory({
      workspaceDir,
      bin: shortBin,
      iterations,
      inputs,
      baseName: runLog.runId,
    });

    for (let i = 1; i <= iterations; i++) {
      runFailed = false;
      // Set to the gate stage's HEAD once that stage returns without having
      // committed anything; every later stage of the iteration is then recorded
      // as `skipped` instead of costing a container run. Reset per iteration.
      let skipHead: string | undefined;
      for (let s = 0; s < stages.length; s++) {
        const stage = stages[s];
        const banner = USE_COLOR
          ? `${dim("\u2501\u2501\u2501")} ${bold(`iteration ${i}/${iterations}`)} ${dim("\u00b7")} ${bold(stage.name)} ${dim(`(stage ${s + 1}/${stages.length})`)} ${dim("\u2501\u2501\u2501")}`
          : `== iteration ${i}/${iterations} \u00b7 ${stage.name} (stage ${s + 1}/${stages.length}) ==`;
        process.stderr.write(`\n${banner}\n`);

        if (skipHead !== undefined) {
          process.stderr.write(
            `${dim(`skipped \u00b7 HEAD unchanged (${skipHead})`)}\n`
          );
          recordEntry({
            iteration: i,
            stage: stage.name,
            status: "skipped",
            durationMs: 0,
            head: skipHead,
            // No stage ran, so there is no NDJSON log to point at.
            logPath: "-",
            body: `Skipped: HEAD did not move during the ${stages[0].name} stage.`,
            // Uncommitted paths the gate left behind: the next implementer
            // reads them off this entry through {{ HISTORY }}.
            dirty: dirtySnapshot(workspaceDir),
          });
          continue;
        }

        const templatePath = join(packageDir, "templates", stage.template);
        const spillRel = `spill-${process.pid}-${i}-${s}-${Date.now()}`;
        const spillHostDir = join(workspaceDir, ".ralph-tmp", spillRel);
        const spillRefPath = posix.join(".ralph-tmp", spillRel);

        const stageLog = stageLogPath(workspaceDir, i, stage.name);
        mkdirSync(dirname(stageLog), { recursive: true });

        // Duration is measured around the whole retried call. HEAD is captured
        // before the stage runs so a reviewer that commits a fix is recorded as
        // review-fix (before vs after).
        const startedAt = Date.now();
        const headBefore = headShort(workspaceDir);
        const logPath = posix.join(".ralph-tmp", "logs", basename(stageLog));
        // A signal arriving now records an `aborted` entry for this stage;
        // cleared once the stage's own entry is written below.
        current = { iteration: i, stage: stage.name, startedAt, logPath };
        runLog.append({
          type: "stage.started",
          iteration: i,
          stageIndex: s,
          stage: stage.name,
          logPath,
          container: containerName(i, s, 1),
        });
        // One message per failed attempt, collected from the retry callback and
        // rendered as `retries:` + `- attempt <k>:` bullets on the entry.
        const attemptErrors: string[] = [];
        let attempt = 0;
        // A stage.retry that cannot be logged fails the run at once: rethrown
        // from the retry callback, it skips the backoff and every later attempt.
        let retryLogError: unknown;
        let result: { text: string; meta: StageMeta };
        try {
          result = await withRetries(
            () => {
              attempt++;
              // Render inside the retry: a failing template shell/@spill tag
              // (e.g. a flaky `gh issue list`) is retried with backoff instead
              // of crashing the loop — and a hard failure surfaces as a terminal
              // stage failure rather than a degraded prompt that false-completes.
              // Only the gate (implementer) reads history; the reviewer does not.
              // Loaded inside the retry closure so a retried render sees fresh
              // history (a prior stage may have appended an entry meanwhile).
              const prompt = renderTemplate(
                templatePath,
                {
                  INPUTS: inputs,
                  HISTORY: s === 0 ? loadHistoryTail(workspaceDir) : "",
                },
                { cwd: workspaceDir, spillHostDir, spillRefPath }
              );
              return runStage(
                stage,
                prompt,
                workspaceDir,
                i,
                spillHostDir,
                stageLog,
                {
                  signal: stageAbort.signal,
                  agent,
                  codexUserConfig,
                  skillsHostDir: join(packageDir, "templates", "skills"),
                  container: {
                    name: containerName(i, s, attempt),
                    runId: runLog.runId,
                  },
                  onOutput: () => {
                    lastOutputAt = Date.now();
                  },
                }
              );
            },
            {
              max: maxRetries,
              backoffMs: DEFAULT_BACKOFF_MS,
              onAttempt: (attempt, err) => {
                attemptErrors.push((err as Error).message);
                const wait = backoffFor(DEFAULT_BACKOFF_MS, attempt);
                try {
                  runLog.append({
                    type: "stage.retry",
                    iteration: i,
                    stage: stage.name,
                    attempt,
                    error: (err as Error).message,
                    backoffMs: wait,
                    container: containerName(i, s, attempt + 1),
                  });
                } catch (appendErr) {
                  retryLogError = appendErr;
                  throw appendErr;
                }
                const marker = `[retry] attempt ${attempt} of ${maxRetries} after ${wait} ms`;
                process.stderr.write(
                  `${USE_COLOR ? dim(marker) : marker} ${dim("(" + (err as Error).message + ")")}\n`
                );
                try {
                  appendFileSync(stageLog, marker + "\n");
                } catch {
                  // log file may be unwritable; never crash the loop on the marker.
                }
              },
            }
          );
        } catch (err) {
          if (err === retryLogError) throw err;
          const failureMarker = `[failure] iteration ${i} stage ${stage.name} failed after ${maxRetries} retries: ${(err as Error).message}`;
          try {
            appendFileSync(stageLog, failureMarker + "\n");
          } catch {
            // log file may be unwritable; stderr still carries the failure.
          }
          const msg = `${red(SYM.cross)} ${bold("iteration " + i + " stage " + stage.name + " failed")} after ${maxRetries} retries: ${(err as Error).message}`;
          process.stderr.write(msg + "\n");
          recordEntry({
            iteration: i,
            stage: stage.name,
            status: "failed",
            durationMs: Date.now() - startedAt,
            head: headShort(workspaceDir),
            logPath,
            body: (err as Error).message,
            retries: attemptErrors.length || undefined,
            attempts: attemptErrors.length ? attemptErrors : undefined,
            dirty: dirtySnapshot(workspaceDir),
          });
          current = undefined;
          runFailed = true;
          break;
        }

        const headAfter = headShort(workspaceDir);
        const hitSentinel = s === 0 && hasSentinel(result.text);
        if (s === 0 && !hitSentinel && result.text.indexOf(SENTINEL) !== -1) {
          process.stderr.write(
            `[warning] iteration ${i}: the gate mentioned ${SENTINEL} without emitting it on a line of its own; the loop continues\n`
          );
        }
        recordEntry({
          iteration: i,
          stage: stage.name,
          status: deriveStatus({
            isGate: s === 0,
            text: result.text,
            meta: result.meta,
            headBefore,
            headAfter,
          }),
          durationMs: Date.now() - startedAt,
          head: headAfter,
          logPath,
          body: result.text,
          meta: result.meta,
          retries: attemptErrors.length || undefined,
          attempts: attemptErrors.length ? attemptErrors : undefined,
        });
        current = undefined;

        if (hitSentinel) {
          sentinelHit = true;
          completedIterations = i;
          return endRun(history, "no-more-tasks");
        }

        // The gate decides whether the rest of the iteration is worth paying
        // for: an unchanged HEAD (the `-` of a non-git workspace included)
        // means the reviewer would re-review an already-reviewed commit.
        if (s === 0 && headAfter === headBefore) skipHead = headAfter;
      }
      completedIterations = i;
    }
    return endRun(history, runFailed ? "failed" : "cap");
  } catch (err) {
    try {
      runLog.append({
        type: "run.ended",
        reason: "error",
        completedIterations,
        error: (err as Error).message,
      });
    } catch {
      // The log may be what failed; the thrown error still exits non-zero.
    }
    if (notify) notifyError((err as Error).message);
    throw err;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    clearInterval(heartbeat);
    runLog.close();
    releaseOnce();
    if (notify && (sentinelHit || completedIterations === iterations)) {
      notifyComplete(completedIterations, sentinelHit);
    }
  }
}
