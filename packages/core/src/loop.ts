import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";

import {
  CODEX_USER_CONFIG_REQUIRES_CODEX,
  type AgentName,
  type StageMeta,
} from "./agents/index.js";
import { readCoreVersion } from "./cli-help.js";
import {
  dirtySnapshot,
  headShort,
  loadHistoryTail,
  openHistory,
  renderRunTotals,
  type HistoryWriter,
} from "./history.js";
import { acquire, type Releaser } from "./keepalive.js";
import { notifyComplete, notifyError } from "./notify.js";
import { renderTemplate } from "./render.js";
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_RETRIES,
  backoffFor,
  withRetries,
} from "./retry.js";
import { ensureImage, runStage, stageLogPath } from "./runner.js";
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
    return args.text.includes(SENTINEL) ? "no-more-tasks" : "ok";
  }
  if (args.text.includes(REVIEW_OK)) return "review-ok";
  if (args.text.includes(REVIEW_SKIP)) return "review-skip";
  if (args.headAfter !== args.headBefore) return "review-fix";
  return "ok";
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

export async function runLoop(opts: LoopOptions): Promise<void> {
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

  const versionLine = `${bin} ${cliVersion} (core ${readCoreVersion()})`;
  process.stderr.write(
    `${USE_COLOR ? `${dim("━━━")} ${bold(versionLine)} ${dim("━━━")}` : `== ${versionLine} ==`}\n`
  );

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

  // The history writer (opened after ensureImage) and the running stage's
  // `current` slot, both read by the signal handlers. `current` is set at each
  // stage start and cleared once that stage's own entry is written; an empty
  // slot — between stages, or before the image is ready — means a signal records
  // nothing. On a signal the `aborted` entry is the file's terminal marker: the
  // handler exits the process directly, so no footer follows.
  let history: HistoryWriter | undefined;
  let current:
    | { iteration: number; stage: string; startedAt: number; logPath: string }
    | undefined;
  const recordAbort = (body: string): void => {
    if (!history || !current) return;
    try {
      history.appendEntry({
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
  };

  const onSigint = (): void => {
    abortActiveStage();
    recordAbort("Interrupted (SIGINT).");
    if (notify) notifyError("interrupted (SIGINT)");
    releaseOnce();
    process.exit(130);
  };
  const onSigterm = (): void => {
    abortActiveStage();
    recordAbort("Terminated (SIGTERM).");
    if (notify) notifyError("terminated (SIGTERM)");
    releaseOnce();
    process.exit(143);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let completedIterations = 0;
  let sentinelHit = false;
  // Whether the last iteration ended in a stage failure; decides the footer
  // reason (`failed` vs `cap`). Reset at the start of every iteration.
  let runFailed = false;
  try {
    await ensureImage(ralphDir, { signal: stageAbort.signal });

    // History opens only after the image is confirmed: an image failure must
    // leave no .ralph/ directory behind. `bin` arrives as "ralph-afk" /
    // "ralph-ghafk"; the history file uses the short "afk" / "ghafk" form.
    history = openHistory({
      workspaceDir,
      bin: bin.replace(/^ralph-/, ""),
      iterations,
      inputs,
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
          history.appendEntry({
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
        // One message per failed attempt, collected from the retry callback and
        // rendered as `retries:` + `- attempt <k>:` bullets on the entry.
        const attemptErrors: string[] = [];
        let result: { text: string; meta: StageMeta };
        try {
          result = await withRetries(
            () => {
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
                }
              );
            },
            {
              max: maxRetries,
              backoffMs: DEFAULT_BACKOFF_MS,
              onAttempt: (attempt, err) => {
                attemptErrors.push((err as Error).message);
                const wait = backoffFor(DEFAULT_BACKOFF_MS, attempt);
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
          const failureMarker = `[failure] iteration ${i} stage ${stage.name} failed after ${maxRetries} retries: ${(err as Error).message}`;
          try {
            appendFileSync(stageLog, failureMarker + "\n");
          } catch {
            // log file may be unwritable; stderr still carries the failure.
          }
          const msg = `${red(SYM.cross)} ${bold("iteration " + i + " stage " + stage.name + " failed")} after ${maxRetries} retries: ${(err as Error).message}`;
          process.stderr.write(msg + "\n");
          history.appendEntry({
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
        const hitSentinel = s === 0 && result.text.includes(SENTINEL);
        history.appendEntry({
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
          history.appendFooter(i, "no-more-tasks");
          printRunSummary(history, "no-more-tasks", i, iterations);
          return;
        }

        // The gate decides whether the rest of the iteration is worth paying
        // for: an unchanged HEAD (the `-` of a non-git workspace included)
        // means the reviewer would re-review an already-reviewed commit.
        if (s === 0 && headAfter === headBefore) skipHead = headAfter;
      }
      completedIterations = i;
    }
    const reason = runFailed ? "failed" : "cap";
    history.appendFooter(completedIterations, reason);
    printRunSummary(history, reason, completedIterations, iterations);
  } catch (err) {
    if (notify) notifyError((err as Error).message);
    throw err;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    releaseOnce();
    if (notify && (sentinelHit || completedIterations === iterations)) {
      notifyComplete(completedIterations, sentinelHit);
    }
  }
}
