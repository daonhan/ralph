# PRD: Warn when a sandbox install rewrote the host `node_modules`

> Tracks GitHub issue #128 (option 2, the detect-and-warn tracer). Option 1 (isolating `node_modules` behind container-local volumes) is the real fix and is a separate, later slice with its own PRD.

## Problem Statement

When the sandbox agent runs `pnpm install` (or any install) inside the container, it writes into the bind-mounted `node_modules/` of the target workspace with a **Linux** layout: `node_modules/.modules.yaml` ends up with `storeDir: /home/agent/workspace/.pnpm-store/v3`, a `.pnpm-store/` directory appears at the workspace root, and the workspace packages' `node_modules/` get Linux symlinks. Back on the Windows host the tree looks clean to `git status` (both paths are gitignored), but the first host `pnpm` / `tsc` / `vitest` run dies with an unrelated-looking error (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, unresolvable bins, `EPERM` on symlinks). The only repair is to delete the tree and reinstall on the host.

Observed on this repository after each of the last three `ralph-ghafk` runs on 2026-09-08 (the runs behind PRs #107, #116 and #125). Nothing in Ralph prevents, detects or warns about it; the harness that drives Ralph's own development carries a hand-written repair step for it. The user learns about the damage only when an unrelated command fails, usually much later.

## Solution

At every non-signal loop exit (sentinel, cap, failed), Ralph inspects the host workspace for the two fingerprints a sandbox install leaves, and when it finds any:

- prints one stderr warning block naming each finding and the repair, using the same `[…]` marker style as the existing `[failure]` / `[keepalive]` lines:

  ```
  [warning] sandbox install rewrote the host node_modules:
    - node_modules/.modules.yaml storeDir: /home/agent/workspace/.pnpm-store/v3
    - .pnpm-store/ present at the workspace root
    repair on the host: delete node_modules/ and .pnpm-store/, then run your install command
  ```

- appends ` · warning: sandbox-install` to the history footer, after the run totals, so the history file records that this run left the host tree unusable:

  ```
  --- ended · 3/3 iterations · cap · 5 stages · $4.12 · 118.3k in / 9.6k out · 42m10s · warning: sandbox-install
  ```

When nothing is found, neither the terminal nor the footer changes by a single byte.

The two fingerprints:

1. `<workspace>/node_modules/.modules.yaml` exists and its `storeDir:` value starts with `/home/agent/` (the sandbox user's home; the host's store is never there).
2. `<workspace>/.pnpm-store/` exists as a directory (pnpm inside the container falls back to a store under the workspace because the container home is not the bind mount).

This is a tracer: the damage is already done when the warning prints. The value is that the user sees it in the terminal and in the history file the moment the run ends, with the repair, instead of discovering it later from a misleading error.

## User Stories

1. As a Windows Ralph user returning to a finished AFK run, I want the terminal to tell me when the sandbox rewrote my `node_modules`, so that I repair it before my next host command fails with an unrelated error.
2. As that user, I want the warning to name what was found (the store path in `.modules.yaml`, the stray `.pnpm-store/`), so that I can verify the claim in seconds.
3. As that user, I want the warning to carry the repair, so that I do not have to search for it.
4. As a Ralph user reading `.ralph/history/` later, I want the footer to record that the run left the host tree in this state, so that a broken host after a series of runs can be traced to the run that did it.
5. As a Ralph user whose run left the host tree intact, I want no output change at all, so that the summary line and the footer stay exactly as today.
6. As a Ralph user interrupting a run with Ctrl+C, I want the signal path unchanged (no footer, no check, exit codes 130 / 143), so that signal handling is untouched.
7. As a Ralph user of a workspace with no `node_modules` at all (a Python or .NET repo), I want no check output and no file reads beyond two existence checks, so that the feature costs nothing where it does not apply.
8. As a Ralph maintainer, I want the detection in one small pure-filesystem module with its own tests, so that option 1 can later reuse it as its regression oracle ("after a run, the check finds nothing").
9. As a Ralph maintainer, I want the footer's existing prefix and totals segment byte-identical when there is no warning, so that everything that reads or greps the footer today keeps working.
10. As a Ralph maintainer, I want no new flag or environment variable, so that the knob table does not grow for a warning that has no sensible opposite.
11. As a reader of the README troubleshooting section, I want an entry for the warning text with the repair for PowerShell and bash, so that the documented runtime matches the code.

## Implementation Decisions

- **Detection module.** A new `packages/core/src/host-check.ts` exports `detectSandboxInstall(workspaceDir): string[]`: it returns one human-readable finding per fingerprint present, in the order listed above, and an empty array otherwise. Pure `fs` (`existsSync`, `statSync`, `readFileSync`), no shell, no docker. The `.modules.yaml` read is a line scan for `^storeDir:\s*(.+)$`; no YAML parser is added. The `/home/agent/` prefix is a module constant, matching the sandbox user in `packages/core/templates/Dockerfile`.
- **When it runs.** The loop driver calls it once, right before each of its two footer writes (sentinel branch, cap/failed branch), and passes the findings on. The signal path is untouched. A failing check (a permission error on `.modules.yaml`, say) is caught inside the module and reported as no findings — the check must never turn a finished run into a crash.
- **Terminal output.** When findings exist, the loop driver writes the stderr block shown above (marker `[warning]`, one `- ` line per finding, one repair line) before the footer and the stdout summary line. stderr, like the stage banners and skip notices; the stdout summary line is unchanged.
- **Footer.** `appendFooter(completed, reason)` gains an optional third parameter, the findings array; when it is non-empty the footer gets ` · warning: sandbox-install` appended after the totals segment. `renderRunTotals` is untouched, so the stdout summary line never carries the suffix (the terminal gets the full block instead). The tail parser keys on the `--- ended ` prefix and is untouched.
- **Repair wording.** The stderr line says what to delete and to run "your install command" rather than guessing `pnpm` vs `npm`; the README entry gives both shells' exact commands.
- **Documentation.** README troubleshooting gains one bullet keyed on the warning text; the architecture reference's loop-exit description mentions the check and the footer suffix; `CONTEXT.md`'s gotcha list gains the line. No env-var table change (no knob).
- **No knob.** Rollback is a revert of the feature commits.

## Testing Decisions

- **What makes a good test here.** The module's contract is the findings it returns for a directory layout; the loop's contract is what reaches stderr and the history file. Tests build the layout in a temporary workspace and assert on the returned strings, the stderr text and the footer line. No mocking of `fs`.
- **Modules under test.** `host-check.ts` (new suite `host-check.test.ts`), the history writer (footer suffix), the loop driver (stderr block + footer via the existing mocked-runner pattern).
- **Cases, detection.**
  1. Empty temp dir → `[]`.
  2. `node_modules/.modules.yaml` with `storeDir: D:\.pnpm-store\v3` (a healthy Windows store) → `[]`.
  3. `node_modules/.modules.yaml` with `storeDir: /home/agent/workspace/.pnpm-store/v3` → one finding containing that path.
  4. `.pnpm-store/` directory only → one finding naming `.pnpm-store/`.
  5. Both → two findings, `.modules.yaml` first.
  6. `.modules.yaml` present but unreadable as UTF-8 text or lacking a `storeDir:` line → `[]` (no throw).
- **Cases, history writer.** `appendFooter(2, "cap", ["x"])` → the footer ends with ` · warning: sandbox-install`; `appendFooter(2, "cap")` and `appendFooter(2, "cap", [])` → footer byte-identical to today's.
- **Cases, loop driver.** A temp workspace carrying a sandbox-shaped `.modules.yaml`, 1 iteration, sentinel on the gate → stderr contains `[warning] sandbox install rewrote the host node_modules` and the finding line, and the history footer ends with ` · warning: sandbox-install`; the same run without the file → stderr has no `[warning]` and the footer matches the existing `/· no-more-tasks · 1 stages/` expectation with no `warning` text. The cap/failed branch gets one case as well.
- **Prior art.** The loop suite's mocked runner + temporary workspace pattern and its stderr/stdout spies; the history suite's footer regexes.

## Out of Scope

- Preventing the rewrite (option 1: container-local `node_modules` volumes, a cached store volume) — separate PRD, tracked by #128.
- Detecting npm-only damage (Linux symlinks in `node_modules/.bin` without a pnpm fingerprint); the `.pnpm-store/` check already covers the "pnpm store over an npm tree" case from the issue.
- Running the check per stage, in `--print-config`, or on the Ctrl+C path.
- A playbook rule telling the agent not to install (option 3).
- Carrying the warning into the `--notify` toast.
- Auto-repairing the host tree.

## Further Notes

- Evidence on this workspace on 2026-09-08 after the 0.9.x run: `.pnpm-store/` present at the root (gitignored, so invisible to `git status`); `node_modules/.modules.yaml` had been repaired by hand to `storeDir: D:\.pnpm-store\v3` before this PRD was written, and read `/home/agent/workspace/.pnpm-store/v3` right after each of the three runs named in #128.
- The loop driver's two footer writes are the sentinel branch and the cap/failed branch after the loop; `printRunSummary` is called right after each and stays unchanged. `renderFooter` is the only place the footer text is built.
- Both fingerprint paths are in this repo's `.gitignore` (`node_modules/`, `.pnpm-store/`), which is why the damage is invisible to git and to the reviewer stage's `git status` reads.
- Stress-test & provoke:
  - Killer assumption: [problem] users discover the damage late, from an unrelated error → probe: three consecutive runs on this repo, each repaired only after a host command failed; the slice-cycle tooling carries a hand-written repair step for exactly this.
  - Other assumptions: [feasibility] two `fs` reads at loop end; [solution] a footer token plus a stderr block is enough for a tracer; [user] Windows + Docker Desktop is the primary host today.
  - Strongest counter: option 1 makes this moot, so why ship it — survives because option 1 needs a design decision and a PRD, this ships in one small PR now, and its detection module becomes option 1's regression oracle.
  - Would be unnecessary if: the runner already isolated `node_modules` — it does not (one bind mount of the whole workspace at `runner.ts`'s `docker run` args).
