import { execFileSync } from "node:child_process";
import { acquire, type Releaser } from "./keepalive.js";
import { runLoop } from "./loop.js";
import { notifyComplete, notifyError } from "./notify.js";
import { sleep } from "./pacing.js";
import {
  bold,
  dim,
  greenOut,
  boldOut,
  dimOut,
  SYM_OUT,
  USE_COLOR,
} from "./stream-render.js";
import type { Stage } from "./stages.js";

/** Count open issues carrying `label`, via gh. Returns 0 on any failure (keep polling). */
export function openIssueCount(label: string, cwd: string): number {
  try {
    // execFileSync (no shell) so `label` is passed as a literal argv entry — a
    // value like `$(rm -rf ~)` can never be shell-evaluated. See SECURITY.md.
    const out = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        label,
        "--json",
        "number",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const arr = JSON.parse(out) as unknown[];
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    process.stderr.write(
      `${dim(`gh issue poll failed (label ${label}) — treating as no work`)}\n`
    );
    return 0;
  }
}

export type RunWatchOptions = {
  stages: [Stage, ...Stage[]];
  iterations: number;
  workspaceDir: string;
  packageDir: string;
  watchIntervalSec: number;
  watchLabel: string;
  budgetUsd?: number;
  cooldownMs?: number;
  maxRetries?: number;
  reviewLenses?: string[];
  notify?: boolean;
  bin?: string;
  cliVersion?: string;
  /** Injectable for tests; defaults to openIssueCount. */
  countIssues?: (label: string, cwd: string) => number;
};

export async function runWatch(opts: RunWatchOptions): Promise<void> {
  const {
    stages,
    iterations,
    workspaceDir,
    packageDir,
    watchIntervalSec,
    watchLabel,
    budgetUsd,
    cooldownMs,
    maxRetries,
    reviewLenses,
    notify = false,
    bin = "ralph-ghafk",
    countIssues = openIssueCount,
  } = opts;

  const releaser: Releaser = acquire({ reason: `${bin} watch` });
  let released = false;
  const releaseOnce = (): void => {
    if (!released) {
      released = true;
      releaser.release();
    }
  };
  const daemonAbort = new AbortController();

  const onSig = (code: number) => (): void => {
    daemonAbort.abort();
    if (notify) notifyError(`watch stopped (signal)`);
    releaseOnce();
    process.exit(code);
  };
  const onSigint = onSig(130);
  const onSigterm = onSig(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  process.stderr.write(
    `${USE_COLOR ? dim("watching") + " " + bold(`label:${watchLabel} every ${watchIntervalSec}s`) : `watching label:${watchLabel} every ${watchIntervalSec}s`}\n`
  );

  let cumulativeCost = 0;
  try {
    for (;;) {
      if (budgetUsd != null && cumulativeCost >= budgetUsd) {
        process.stdout.write(
          `${greenOut(SYM_OUT.bullet)} ${boldOut("watch budget reached")}${dimOut(` $${cumulativeCost.toFixed(2)} ≥ $${budgetUsd.toFixed(2)} — stopping`)}\n`
        );
        if (notify) notifyComplete(0, false);
        return;
      }
      const count = countIssues(watchLabel, workspaceDir);
      if (count > 0) {
        process.stderr.write(
          `${dim(`${count} open issue(s) labelled ${watchLabel} — running loop`)}\n`
        );
        const remaining =
          budgetUsd != null ? budgetUsd - cumulativeCost : undefined;
        const outcome = await runLoop({
          stages,
          inputs: "",
          iterations,
          workspaceDir,
          packageDir,
          budgetUsd: remaining,
          cooldownMs,
          maxRetries,
          reviewLenses,
          noKeepAlive: true,
          signal: daemonAbort.signal,
          bin,
          cliVersion: opts.cliVersion,
        });
        cumulativeCost += outcome.costUsd;
        process.stderr.write(
          `${dim(`watch run done — cumulative $${cumulativeCost.toFixed(2)}`)}\n`
        );
      }
      await sleep(watchIntervalSec * 1000, daemonAbort.signal);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    releaseOnce();
  }
}
