import { appendFileSync } from "node:fs";

import { readCoreVersion } from "./cli-help.js";
import { acquire, type Releaser } from "./keepalive.js";
import { notifyComplete, notifyError } from "./notify.js";
import { sleep, isThrottle, nextCooldownFactor } from "./pacing.js";
import { DEFAULT_MAX_RETRIES } from "./retry.js";
import { stageLogPath, type StageResult } from "./runner.js";
import { executeStage } from "./stage-exec.js";
import {
  USE_COLOR,
  dim,
  bold,
  red,
  greenOut,
  boldOut,
  dimOut,
  SYM,
  SYM_OUT,
} from "./stream-render.js";
import type { Stage } from "./stages.js";

// The agent emits this literal when there is no more work; the same string is
// mirrored in the playbook templates (prompt.md / ghprompt.md) that instruct it.
const SENTINEL = "<promise>NO MORE TASKS</promise>";

export type LoopOptions = {
  // First stage is the gate: its result is checked for the completion sentinel.
  // Subsequent stages always run after a non-sentinel gate result.
  stages: [Stage, ...Stage[]];
  inputs: string;
  iterations: number;
  /** Host repo Claude runs against (cwd). */
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
  /** Stop the loop when cumulative stage cost reaches this USD ceiling. */
  budgetUsd?: number;
  /** Milliseconds to wait between iterations. 0 = no cooldown. */
  cooldownMs?: number;
  /** Opt-in reviewer panel: replace the single reviewer stage with K read-only lens reviewers + one synth commit. */
  reviewLenses?: string[];
  /** Injected AbortSignal for daemon callers (e.g. watch mode). When provided,
   *  runLoop skips wake-lock acquisition and process signal handler installation;
   *  the caller owns both. */
  signal?: AbortSignal;
};

export type LoopOutcome = { costUsd: number; sentinelHit: boolean };

export async function runLoop(opts: LoopOptions): Promise<LoopOutcome> {
  const {
    stages,
    inputs,
    iterations,
    workspaceDir,
    packageDir,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    notify = false,
    bin = "ralph",
    cliVersion = "?",
    budgetUsd,
    cooldownMs = 0,
    reviewLenses,
    signal: externalSignal,
  } = opts;

  const versionLine = `${bin} ${cliVersion} (core ${readCoreVersion()})`;
  process.stderr.write(
    `${USE_COLOR ? `${dim("━━━")} ${bold(versionLine)} ${dim("━━━")}` : `== ${versionLine} ==`}\n`
  );

  // When an external signal is injected (daemon/watch mode), the caller owns
  // wake-lock + process signal handlers. Skip both here.
  const releaser: Releaser =
    externalSignal || noKeepAlive
      ? { release: () => {} }
      : acquire({ reason: `${bin} loop` });
  const stageAbort = externalSignal ? undefined : new AbortController();
  const activeSignal = externalSignal ?? stageAbort!.signal;

  // Single release path: signal handlers and the finally below all funnel
  // through releaseOnce so the wake-lock child is killed exactly once.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaser.release();
  };

  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  if (!externalSignal) {
    const abortActiveStage = (): void => {
      if (!stageAbort!.signal.aborted) stageAbort!.abort();
    };
    onSigint = (): void => {
      abortActiveStage();
      if (notify) notifyError("interrupted (SIGINT)");
      releaseOnce();
      process.exit(130);
    };
    onSigterm = (): void => {
      abortActiveStage();
      if (notify) notifyError("terminated (SIGTERM)");
      releaseOnce();
      process.exit(143);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }

  let completedIterations = 0;
  let sentinelHit = false;
  let runCostUsd = 0;
  let cooldownFactor = 1;

  // Single source of truth for per-stage accounting: tally cost, report it,
  // advance the adaptive cooldown factor on throttle, and report whether the
  // budget is now exhausted. Used once per non-panel stage AND once per panel
  // sub-agent (passed to runPanel as onStage), so budget + adaptive pacing
  // apply uniformly to lenses, synth, and ordinary stages alike.
  const accountStage = (
    sr: StageResult
  ): { stop: boolean; cooldownFactor: number } => {
    runCostUsd += sr.costUsd;
    process.stderr.write(
      `${dim(`· $${sr.costUsd.toFixed(2)} (run $${runCostUsd.toFixed(2)})`)}\n`
    );
    cooldownFactor = nextCooldownFactor(
      cooldownFactor,
      isThrottle(sr.apiErrorStatus)
    );
    return {
      stop: budgetUsd != null && runCostUsd >= budgetUsd,
      cooldownFactor,
    };
  };

  try {
    for (let i = 1; i <= iterations; i++) {
      for (let s = 0; s < stages.length; s++) {
        const stage = stages[s];

        // Budget gate: check before running each stage.
        if (budgetUsd != null && runCostUsd >= budgetUsd) {
          process.stdout.write(
            `${greenOut(SYM_OUT.bullet)} ${boldOut("budget reached")}${dimOut(` $${runCostUsd.toFixed(2)} ≥ $${budgetUsd.toFixed(2)} after ${i - 1} iterations`)}\n`
          );
          return { costUsd: runCostUsd, sentinelHit };
        }

        const banner = USE_COLOR
          ? `${dim("━━━")} ${bold(`iteration ${i}/${iterations}`)} ${dim("·")} ${bold(stage.name)} ${dim(`(stage ${s + 1}/${stages.length})`)} ${dim("━━━")}`
          : `== iteration ${i}/${iterations} · ${stage.name} (stage ${s + 1}/${stages.length}) ==`;
        process.stderr.write(`\n${banner}\n`);

        const usePanel =
          reviewLenses && reviewLenses.length > 0 && stage.name === "reviewer";

        let sr: StageResult;
        try {
          if (usePanel) {
            // Lazy import to avoid circular dep and keep the panel opt-in.
            const { runPanel } = await import("./panel.js");
            sr = await runPanel({
              lenses: reviewLenses!,
              workspaceDir,
              packageDir,
              iteration: i,
              maxRetries,
              cooldownMs,
              signal: activeSignal,
              onStage: accountStage,
            });
          } else {
            sr = await executeStage({
              stage,
              vars: { INPUTS: inputs },
              workspaceDir,
              packageDir,
              iteration: i,
              maxRetries,
              signal: activeSignal,
            });
            accountStage(sr);
          }
        } catch (err) {
          if (activeSignal.aborted) {
            return { costUsd: runCostUsd, sentinelHit };
          }
          // terminal failure marker — write to the same log path executeStage used.
          const stageLog = stageLogPath(workspaceDir, i, stage.name);
          const failureMarker = `[failure] iteration ${i} stage ${stage.name} failed after ${maxRetries} retries: ${(err as Error).message}`;
          try {
            appendFileSync(stageLog, failureMarker + "\n");
          } catch {
            // log file may be unwritable; stderr still carries the failure.
          }
          const msg = `${red(SYM.cross)} ${bold("iteration " + i + " stage " + stage.name + " failed")} after ${maxRetries} retries: ${(err as Error).message}`;
          process.stderr.write(msg + "\n");
          break;
        }

        // Cost/pacing accounting is handled by accountStage — called once per
        // non-panel stage above, and once per sub-agent inside runPanel.

        if (s === 0) {
          if (sr.result.includes(SENTINEL)) {
            const msg =
              greenOut(SYM_OUT.bullet) +
              " " +
              boldOut("Ralph complete") +
              dimOut(" after " + i + " iterations");
            process.stdout.write(msg + "\n");
            sentinelHit = true;
            completedIterations = i;
            return { costUsd: runCostUsd, sentinelHit };
          }
        }
      }
      completedIterations = i;

      // Cooldown between iterations.
      if (cooldownMs > 0 && i < iterations) {
        const wait = cooldownMs * cooldownFactor;
        if (cooldownFactor > 1) {
          process.stderr.write(
            `${dim(`cooldown ×${cooldownFactor} → ${wait}ms (throttle backoff)`)}\n`
          );
        }
        await sleep(wait, activeSignal);
      }
    }
  } catch (err) {
    if (notify) notifyError((err as Error).message);
    throw err;
  } finally {
    if (onSigint) process.off("SIGINT", onSigint);
    if (onSigterm) process.off("SIGTERM", onSigterm);
    releaseOnce();
    if (notify && (sentinelHit || completedIterations === iterations)) {
      notifyComplete(completedIterations, sentinelHit);
    }
  }
  return { costUsd: runCostUsd, sentinelHit };
}
