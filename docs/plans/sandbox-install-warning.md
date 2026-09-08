# Plan: Warn when a sandbox install rewrote the host `node_modules`

> Source PRD: [docs/prd/sandbox-install-warning.md](../prd/sandbox-install-warning.md) · tracks #128 (option 2, tracer)

## Architectural decisions

Durable decisions that apply across all phases:

- **One pure detection module.** `packages/core/src/host-check.ts` exports `detectSandboxInstall(workspaceDir: string): string[]`. Two fingerprints, checked in this order, one finding string each: (1) `<workspace>/node_modules/.modules.yaml` whose `storeDir:` line value starts with `/home/agent/` → `node_modules/.modules.yaml storeDir: <value>`; (2) `<workspace>/.pnpm-store/` is a directory → `.pnpm-store/ present at the workspace root`. `SANDBOX_HOME = "/home/agent/"` is a module constant. Pure `node:fs`; a line scan (`/^storeDir:\s*(.+?)\s*$/m`), no YAML dependency; every `fs` failure is caught and yields no finding.
- **Runs at the two footer writes only.** The loop driver calls it right before `appendFooter` in the sentinel branch and in the cap/failed branch. Never on the signal path, never per stage.
- **Terminal block** (stderr, before the footer write and the stdout summary line), exactly:

  ```
  [warning] sandbox install rewrote the host node_modules:
    - <finding 1>
    - <finding 2>
    repair on the host: delete node_modules/ and .pnpm-store/, then run your install command
  ```

  Plain text, no ANSI (matches the existing `[failure]` line style).

- **Footer suffix.** `appendFooter(completed, reason, findings?: string[])`; a non-empty `findings` appends ` · warning: sandbox-install` after the totals segment. `renderRunTotals` and the stdout summary line are unchanged. The `--- ended ` prefix and the tail parser are untouched.
- **No knob.** No flag, no environment variable. Rollback = revert the feature commits.
- **Verification**: per phase, the targeted suite by file path plus the core typecheck; the whole-repo gate (`pnpm -r typecheck && pnpm -r test && pnpm test`) is the review session's job, not a per-phase criterion.

---

## Phase 1: The detection module reports the two sandbox-install fingerprints

**User stories**: 2, 7, 8

### What to build

Add `packages/core/src/host-check.ts` with `detectSandboxInstall(workspaceDir)` as specified above, and a new suite `packages/core/src/__tests__/host-check.test.ts` that builds each layout in a temporary directory (`mkdtempSync` under `os.tmpdir()`, the pattern the history suite uses) and asserts on the returned array. Nothing else changes in this phase; the module is not yet wired.

### Acceptance criteria

- [ ] Empty temp dir → `detectSandboxInstall(dir)` returns `[]`.
- [ ] `node_modules/.modules.yaml` containing `storeDir: D:\.pnpm-store\v3` (plus a few other `key: value` lines) → `[]`.
- [ ] `node_modules/.modules.yaml` containing `storeDir: /home/agent/workspace/.pnpm-store/v3` → exactly one finding equal to `node_modules/.modules.yaml storeDir: /home/agent/workspace/.pnpm-store/v3`.
- [ ] `.pnpm-store/` directory only (no `node_modules`) → exactly one finding equal to `.pnpm-store/ present at the workspace root`.
- [ ] Both fingerprints → two findings, the `.modules.yaml` one first.
- [ ] `.modules.yaml` present with no `storeDir:` line → `[]`; `node_modules/.modules.yaml` present as a **directory** (an `fs` read error) → `[]` and no throw.
- [ ] `grep -c "export function detectSandboxInstall" packages/core/src/host-check.ts` reads 1 (file does not exist today); `grep -o "from \"js-yaml\"\|from \"yaml\"" packages/core/src/host-check.ts | wc -l` reads 0 (no YAML dependency); `grep -o "child_process" packages/core/src/host-check.ts | wc -l` reads 0.
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/host-check.test.ts` green (new suite, at least six tests) and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Phase 2: The loop warns on stderr and the footer records it

**User stories**: 1, 3, 4, 5, 6, 9, 10

### What to build

In `history.ts`, give `appendFooter` the optional third parameter and make `renderFooter` append ` · warning: sandbox-install` when the array is non-empty. In `loop.ts`, add a small helper that calls `detectSandboxInstall(workspaceDir)`, writes the stderr block when findings exist, and returns them; call it right before each of the two `appendFooter` calls and pass the findings through. The signal handlers, `printRunSummary`, `renderRunTotals` and the notify calls are untouched.

Pin it in the history suite (footer with and without findings) and in the loop suite, using its mocked runner + temporary workspace pattern and its `process.stderr.write` spy.

### Acceptance criteria

- [ ] History: writer opened with 3 iterations, one `implementer · ok` entry, `appendFooter(1, "cap", ["x"])` → the file's last line matches `/^--- ended · 1\/3 iterations · cap · 1 stages · \d+s · warning: sandbox-install$/`.
- [ ] History: `appendFooter(1, "cap")` and `appendFooter(1, "cap", [])` → the last line matches `/^--- ended · 1\/3 iterations · cap · 1 stages · \d+s$/` (no `warning` text).
- [ ] Loop: temp workspace with `node_modules/.modules.yaml` reading `storeDir: /home/agent/workspace/.pnpm-store/v3`, 1 iteration, gate emits the sentinel → the joined stderr writes contain `[warning] sandbox install rewrote the host node_modules:` followed by `  - node_modules/.modules.yaml storeDir: /home/agent/workspace/.pnpm-store/v3` and `  repair on the host: delete node_modules/ and .pnpm-store/, then run your install command`; the history footer ends with ` · warning: sandbox-install`; the stdout `Ralph ended` line contains no `warning` text.
- [ ] Loop: same workspace, 1 iteration, gate returns plain text (cap exit) → the stderr block appears once and the footer ends with ` · warning: sandbox-install`.
- [ ] Loop: temp workspace with no `node_modules` and no `.pnpm-store` → stderr contains no `[warning]`, and every existing footer expectation (`/--- ended · 1\/1 iterations · failed/`, `· no-more-tasks/`, `· cap/`) keeps passing unchanged.
- [ ] Loop: the existing SIGINT test keeps passing unchanged (no footer, no `[warning]`).
- [ ] `grep -o "detectSandboxInstall" packages/core/src/loop.ts | wc -l` reads ≥ 2 (import + call; today 0); `grep -o "warning: sandbox-install" packages/core/src/history.ts | wc -l` reads 1 (today 0); `grep -o "startsWith(\"--- ended \")" packages/core/src/history.ts | wc -l` still reads 1; `grep -o "Ralph ended" packages/core/src/loop.ts | wc -l` still reads 1.
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/loop.test.ts src/__tests__/history.test.ts` green (today 40 + 26 tests; this phase adds at least three to the loop suite and two to the history suite) and `pnpm --filter @daonhan/ralph-core typecheck` green.

---

## Phase 3: Docs name the warning and the repair

**User stories**: 11

### What to build

- README `## Troubleshooting`: one new bullet, bold-keyed on `[warning] sandbox install rewrote the host node_modules`, explaining that the sandbox agent ran an install into the bind-mounted `node_modules/` (Linux store path / symlinks), that the host tree must be reinstalled before host commands work again, and giving the repair for both shells:

  ```powershell
  Remove-Item -Recurse -Force node_modules, .pnpm-store -ErrorAction SilentlyContinue; pnpm install
  ```

  ```bash
  rm -rf node_modules .pnpm-store && pnpm install
  ```

  plus one sentence that the run's history footer carries ` · warning: sandbox-install`, and that #128 tracks the isolation fix.

- `docs/ARCHITECTURE.md`: in the loop-exit / history description, one sentence: at every non-signal exit the driver runs the sandbox-install check (`host-check.ts`: `.modules.yaml` store path under `/home/agent/`, stray `.pnpm-store/`), prints the `[warning]` block on stderr and appends ` · warning: sandbox-install` to the footer.
- `CONTEXT.md`: one gotcha line next to the existing "Node modules built in WSL break native-Windows bins" line: a sandbox install rewrites the bind-mounted `node_modules` the same way; Ralph warns at loop end and the footer records it; reinstall on the host.
- `CLAUDE.md` and `AGENTS.md` (twins, edited identically): the `history.ts` bullet's footer description gains `, plus a `warning: sandbox-install` suffix when the host check fired`; and a one-line `host-check.ts` mention in the same architecture list, placed after the `stream-render.ts` item.

### Acceptance criteria

- [ ] `grep -o "sandbox install rewrote the host node_modules" README.md | wc -l` reads ≥ 1 (today 0); `grep -o "rm -rf node_modules .pnpm-store" README.md | wc -l` reads 1 (today 0); `grep -o "Remove-Item -Recurse -Force node_modules, .pnpm-store" README.md | wc -l` reads 1 (today 0); `grep -o "#128" README.md | wc -l` reads ≥ 1 (today 0).
- [ ] `grep -o "warning: sandbox-install" docs/ARCHITECTURE.md CONTEXT.md CLAUDE.md AGENTS.md | wc -l` reads 4 (today 0); `grep -o "host-check.ts" docs/ARCHITECTURE.md CLAUDE.md AGENTS.md | wc -l` reads ≥ 3 (today 0).
- [ ] `diff <(grep -n 'host-check.ts' CLAUDE.md | cut -d: -f2-) <(grep -n 'host-check.ts' AGENTS.md | cut -d: -f2-)` is empty and `diff <(grep -n 'warning: sandbox-install' CLAUDE.md | cut -d: -f2-) <(grep -n 'warning: sandbox-install' AGENTS.md | cut -d: -f2-)` is empty (the twins stay identical on those lines).
- [ ] Verification: `pnpm exec prettier --check README.md docs/ARCHITECTURE.md CONTEXT.md CLAUDE.md AGENTS.md` green and `pnpm test` at the root green (docs-only phase, nothing else moves).

---

## Slice mapping

One pull request; one issue per phase, in dependency order: Phase 1 → Phase 2 → Phase 3 (Phase 3 documents Phases 1–2, so it lands last). Issue #128 stays open as the tracker for option 1 and is referenced, not closed, by this slice.

| Phase | Issue                  |
| ----- | ---------------------- |
| 1     | #129                   |
| 2     | #130 (blocked by #129) |
| 3     | #131 (blocked by #130) |
