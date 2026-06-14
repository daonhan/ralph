import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { executeStage } from "./stage-exec.js";
import { sleep } from "./pacing.js";
import type { StageResult } from "./runner.js";
import { dim, red, SYM } from "./stream-render.js";

const LENS_STAGE = {
  name: "review-lens",
  template: "review-lens.md",
  permissionMode: "bypassPermissions",
};
const SYNTH_STAGE = {
  name: "review-synth",
  template: "review-synth.md",
  permissionMode: "bypassPermissions",
};

/** Per-sub-agent control returned by the loop: budget-stop + adaptive cooldown. */
export type PanelStageControl = { stop: boolean; cooldownFactor: number };

export type RunPanelOptions = {
  lenses: string[];
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  cooldownMs: number;
  signal?: AbortSignal;
  /**
   * Called after every panel sub-agent (each lens + synth) so the loop owns
   * budget + adaptive pacing for them too. Returns whether the budget is now
   * exhausted (stop the panel) and the current adaptive cooldown factor.
   */
  onStage?: (sr: StageResult) => PanelStageControl;
};

function git(args: string[], workspaceDir: string): string | null {
  try {
    // execFileSync (no shell): args are literal — never interpolates runtime data.
    return execFileSync("git", args, {
      cwd: workspaceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Tracked-only worktree dirtiness ("" = clean). Untracked files are ignored. */
function trackedStatus(workspaceDir: string): string | null {
  return git(["status", "--porcelain", "--untracked-files=no"], workspaceDir);
}

/** True if HEAD moved or a tracked file changed since `baseHead`. */
function lensMutatedRepo(
  workspaceDir: string,
  baseHead: string | null
): boolean {
  if (baseHead == null) return false;
  if (git(["rev-parse", "HEAD"], workspaceDir) !== baseHead) return true;
  // Tracked-only: a lens scratch file (untracked) is harmless — synth diffs HEAD.
  return trackedStatus(workspaceDir) !== "";
}

/** Harness-orchestrated reviewer panel: read-only lens reviews → one synth fix(review) commit. */
export async function runPanel(opts: RunPanelOptions): Promise<StageResult> {
  const {
    lenses,
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    cooldownMs,
    signal,
    onStage,
  } = opts;
  const panelRel = `panel-${process.pid}-${iteration}-${Date.now()}`;
  const panelHostDir = join(workspaceDir, ".ralph-tmp", panelRel);
  mkdirSync(panelHostDir, { recursive: true });

  // Lenses are contractually read-only; synth owns the single fix(review:) commit.
  // Snapshot HEAD so we can detect + undo a lens that edits or commits despite the
  // prompt (it runs bypassPermissions, so the OS would let it). We only ENFORCE
  // (reset --hard) when the worktree starts tracked-clean — otherwise a reset would
  // discard pre-existing uncommitted user changes, so we disable the guard and warn.
  const baseHead = git(["rev-parse", "HEAD"], workspaceDir);
  const enforceReadOnly =
    baseHead != null && trackedStatus(workspaceDir) === "";
  if (baseHead != null && !enforceReadOnly) {
    process.stderr.write(
      `${red(SYM.cross)} ${dim("worktree has uncommitted tracked changes — panel lens read-only enforcement disabled (won't risk your changes)")}\n`
    );
  }

  try {
    for (let i = 0; i < lenses.length; i++) {
      const lens = lenses[i];
      process.stderr.write(
        `${dim(`panel lens: ${lens} (${i + 1}/${lenses.length})`)}\n`
      );
      const sr = await executeStage({
        stage: LENS_STAGE,
        vars: { LENS: lens },
        workspaceDir,
        packageDir,
        iteration,
        maxRetries,
        signal,
        logLabel: `lens-${lens}`,
      });

      // Enforce read-only: if the lens committed or edited tracked files, warn and
      // restore HEAD so the next lens / synth see the implementer's commit cleanly.
      // Only runs when the worktree started clean, so reset --hard can only ever
      // discard the lens's own changes — never pre-existing work.
      if (enforceReadOnly && lensMutatedRepo(workspaceDir, baseHead)) {
        process.stderr.write(
          `${red(SYM.cross)} ${dim(`lens ${lens} mutated the repo (read-only violation) — restoring to ${baseHead!.slice(0, 8)}`)}\n`
        );
        git(["reset", "--hard", baseHead!], workspaceDir);
      }

      writeFileSync(
        join(panelHostDir, `findings-${lens}.md`),
        sr.result,
        "utf8"
      );

      const ctrl = onStage?.(sr) ?? { stop: false, cooldownFactor: 1 };
      if (ctrl.stop) return sr; // budget exhausted — skip remaining lenses + synth
      if (cooldownMs > 0) await sleep(cooldownMs * ctrl.cooldownFactor, signal);
    }

    process.stderr.write(`${dim("panel synth")}\n`);
    const synth = await executeStage({
      stage: SYNTH_STAGE,
      vars: { FINDINGS_DIR: `./${posix.join(".ralph-tmp", panelRel)}/` },
      workspaceDir,
      packageDir,
      iteration,
      maxRetries,
      signal,
      logLabel: "synth",
    });
    onStage?.(synth);
    return synth;
  } finally {
    rmSync(panelHostDir, { recursive: true, force: true });
  }
}
