# Plan: Ship a `ralph-tdd` Agent Skill and mount it into the sandbox

> Source PRD: [docs/prd/shipped-skills.md](../prd/shipped-skills.md) · tracks #147

## Architectural decisions

Durable decisions that apply across all phases. They are binding for every issue of this slice.

- **One skills directory, two container paths, zero provider branches outside `agents/`.** The shipped skills live in `packages/core/templates/skills/<name>/`. `runner.ts` mounts that directory once per stage at the path the selected adapter names; `loop.ts` only passes the host path. `render.ts`, `loop.ts` and `runner.ts` never mention a provider.
- **Adapter surface** (`packages/core/src/agents/types.ts`):

  ```ts
  export type AgentCommandContext = {
    // …existing fields…
    /** True when runStage mounted the shipped skills directory into the container. */
    skillsMounted?: boolean;
  };

  export interface AgentAdapter {
    // …existing members…
    /** Read-only mount of the shipped skills directory where this provider discovers skills. */
    skillsMount(hostDir: string): AgentMount;
  }
  ```

  `skillsMounted` is optional so existing call sites and tests that build a context literal keep compiling; absent means `false`.

- **Claude** (`agents/claude.ts`): `export const CLAUDE_SKILLS_ROOT = "/home/agent/ralph-skills";`. `skillsMount(hostDir)` returns `{ hostPath: hostDir, containerPath: CLAUDE_SKILLS_ROOT + "/.claude/skills", readOnly: true }`. When `context.skillsMounted` is true, `buildClaudeCommand` emits `"--add-dir", CLAUDE_SKILLS_ROOT` **immediately after `"claude"` and before `"--verbose"`** — `--add-dir <directories...>` is variadic and would swallow the prompt positional if it were followed by it (the case when `--model` is omitted under third-party routing). The legacy export `buildClaudeArgs(stage, promptContainerPath, modelArgs)` keeps its exact argv: no `--add-dir`.
- **Codex** (`agents/codex.ts`): `export const CODEX_SKILLS_ROOT = "/home/agent/.agents/skills";`. `skillsMount(hostDir)` returns `{ hostPath: hostDir, containerPath: CODEX_SKILLS_ROOT, readOnly: true }`. `buildCodexArgs` does not read `skillsMounted`; the setup script and every existing argument are unchanged. Codex scans `$HOME/.agents/skills` as a User-scope root even under `--ignore-user-config` and `--ephemeral` (source-verified, `codex-rs/core-skills/src/loader.rs` at `rust-v0.144.0`).
- **Runner** (`runner.ts`):

  ```ts
  export type RunStageOptions = {
    // …existing fields…
    /** Host directory of the shipped skills (<core>/templates/skills); mounted read-only when it exists. */
    skillsHostDir?: string;
  };

  export function resolveSkillsMountArgs(
    adapter: AgentAdapter,
    skillsHostDir: string | undefined
  ): string[];
  ```

  `resolveSkillsMountArgs` returns `[]` when `skillsHostDir` is undefined or does not exist on the host (`existsSync`, the guard `resolveAgentRuntimeArgs` applies to credential paths); otherwise `["-v", `${mount.hostPath}:${mount.containerPath}:ro`]` built from `adapter.skillsMount(skillsHostDir)`. `runStage` pushes those args right after `resolveAgentRuntimeArgs(adapter, home)` and passes `skillsMounted: skillsArgs.length > 0` into `adapter.buildCommand({...})`. The host path is a `join` result, so on Windows the spec reads `C:\…\templates\skills:/home/agent/…:ro` — the form the credential mounts already use.

- **Loop** (`loop.ts`): the single `runStage(...)` call gains one property in its options object, `skillsHostDir: join(packageDir, "templates", "skills"),`. Nothing else in the file changes.
- **Skill files** — `packages/core/templates/skills/ralph-tdd/` holds exactly `SKILL.md`, `tests.md`, `mocking.md`, `LICENSE`, all LF line endings. Upstream: `https://github.com/mattpocock/skills`, path `skills/engineering/tdd/`, commit `321658273cb1d20b76026717d027d505790106d4`. Fetch with either form (the sandbox has network and `gh`):

  ```bash
  SHA=321658273cb1d20b76026717d027d505790106d4
  for f in SKILL.md tests.md mocking.md; do
    curl -fsSL "https://raw.githubusercontent.com/mattpocock/skills/$SHA/skills/engineering/tdd/$f" > "packages/core/templates/skills/ralph-tdd/$f"
  done
  curl -fsSL "https://raw.githubusercontent.com/mattpocock/skills/$SHA/LICENSE" > packages/core/templates/skills/ralph-tdd/LICENSE
  # or: gh api "repos/mattpocock/skills/contents/skills/engineering/tdd/<f>?ref=$SHA" --jq .content | base64 -d
  ```

  `tests.md`, `mocking.md`, `LICENSE` stay byte-identical to upstream. Upstream's `agents/openai.yaml` is not copied.

- **`SKILL.md` edits — exactly these, everything else verbatim from upstream:**
  1. Frontmatter (upstream lines 2–3) becomes exactly:

     ```
     name: ralph-tdd
     description: Test-driven implementation for a Ralph iteration. Use when implementing backend or library code: one failing test, the minimum code to make it pass, repeat per vertical slice, tests at public seams.
     ```

  2. Directly after the `# Test-Driven Development` heading, before the intro paragraph, one attribution line:

     ```
     > Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/tdd` (MIT, upstream commit `3216582`) for an unattended Ralph iteration: there is no user to confirm seams with, and refactoring belongs to Ralph's reviewer stage. `tests.md` and `mocking.md` are upstream's, unchanged.
     ```

  3. Upstream lines 22–24 (the paragraph starting `**Test only at pre-agreed seams.**`, the blank line, and the `Ask: "What's the public interface, and which seams should we test?"` line) become this one paragraph:

     ```
     **Test only at seams you named first.** This is an unattended run: there is no user to ask. Before writing any test, write down the seams under test (the public interface, and which of its boundaries the task exercises) and keep to them. List those seams in the commit body so the reviewer stage and the next iteration can see the choice. You can't test everything, so naming the seams up front is how testing effort lands on the critical paths and complex logic instead of every edge case.
     ```

  4. Upstream line 26 (the paragraph beginning `When the shape of that interface is itself in question` and pointing at the `codebase-design` skill) and its following blank line are removed.
  5. Upstream line 38 becomes exactly: `- **Refactoring is not part of the loop.** It belongs to Ralph's reviewer stage, not the red → green implementation cycle.`

- **Playbook text.** In both `prompt.md` and `ghprompt.md` the body of `# IMPLEMENTATION` (today the single line `Complete the task.`) becomes exactly:

  ```
  For backend or library code, use the `ralph-tdd` skill: one failing test, the minimum code to make it pass, repeat per vertical slice. For frontend UI code, implement directly. Complete the task.
  ```

  `review.md`, `afk.md`, `ghafk.md` do not change. The `@include` renderer is single-pass, and the skill is not included — it is mounted.

- **Naming.** Shipped skills are named `ralph-<topic>`; the directory name equals the frontmatter `name`.
- **No knob, no `--print-config` line, no Dockerfile change, no change to `sandbox-volumes.ts` or `cli-help.ts`.**
- **Release components.** Skill files and playbooks live under `packages/core/templates` and bump `ralph-sandbox`; the `src/` changes bump `ralph-core`. Both are expected in this slice's release PR.
- **BUILD constraints** (from `.ralph/history/2026-09-09-*.md`): the workspace is a CRLF checkout on a Windows bind mount — write new files LF, stage by explicit path (never `git commit -am`), commit with `-c core.hooksPath=/dev/null`. The sandbox has no Docker CLI and cannot start a nested ralph run; every live check is REVIEW's. `cli-help.test.ts` has been prettier-dirty since `930e445` — pre-existing, leave it.
- **Verification:** per phase, the targeted suite by file path plus the core typecheck. The whole-repo gate (`pnpm -r typecheck && pnpm -r test && pnpm test`) is the review session's job. Baselines today: core vitest 17 files / 234 tests; `template-contract.test.ts` 6 tests; root `pnpm test` 60 tests; every identifier introduced below (`ralph-tdd`, `skillsMount`, `skillsMounted`, `skillsHostDir`, `resolveSkillsMountArgs`, `CLAUDE_SKILLS_ROOT`, `CODEX_SKILLS_ROOT`, `--add-dir`, `templates/skills`, `ralph-skills`, `.agents/skills`) occurs **0** times under `packages/core/src`, `packages/core/templates` and the seven docs files.

---

## Phase 1: The skill ships in the templates directory

**User stories**: 1, 4, 9, 10

### What to build

Create `packages/core/templates/skills/ralph-tdd/` from the pinned upstream commit (fetch commands above), apply the five `SKILL.md` edits verbatim, and pin the content with a new `describe("shipped skills", …)` block in `packages/core/src/__tests__/template-contract.test.ts` (read the skill through the same `new URL("../../templates/…", import.meta.url)` helper the file already uses): the frontmatter `name` is `ralph-tdd`; the `description` is non-empty and under 1024 characters (Codex's cap); the body contains none of `confirm them with the user`, `codebase-design`, `` `code-review` ``; `tests.md`, `mocking.md` and `LICENSE` exist beside `SKILL.md`. Nothing under `src/` changes and no playbook changes in this phase.

### Acceptance criteria

- [ ] `ls packages/core/templates/skills/ralph-tdd` prints exactly four entries: `LICENSE`, `SKILL.md`, `mocking.md`, `tests.md` (no `agents/`).
- [ ] `sed -n 1,4p packages/core/templates/skills/ralph-tdd/SKILL.md` prints `---`, then `name: ralph-tdd`, then the exact `description:` line from the Architectural decisions, then `---`; `sed -n 3p … | wc -c` reads less than 1024.
- [ ] `SHA=321658273cb1d20b76026717d027d505790106d4; for f in tests.md mocking.md; do diff <(curl -fsSL https://raw.githubusercontent.com/mattpocock/skills/$SHA/skills/engineering/tdd/$f) packages/core/templates/skills/ralph-tdd/$f; done` prints nothing, and `diff <(curl -fsSL https://raw.githubusercontent.com/mattpocock/skills/$SHA/LICENSE) packages/core/templates/skills/ralph-tdd/LICENSE` prints nothing.
- [ ] `grep -c "confirm them with the user" packages/core/templates/skills/ralph-tdd/SKILL.md` reads 0; the same for `codebase-design`, for `code-review`, and for `Ask: "What`.
- [ ] `grep -c "Test only at seams you named first" …/SKILL.md` reads 1; `grep -c "commit body" …/SKILL.md` reads 1; `grep -c "mattpocock/skills" …/SKILL.md` reads 1; `grep -c "3216582" …/SKILL.md` reads 1; `grep -c "reviewer stage" …/SKILL.md` reads 2 (attribution line + last rule).
- [ ] Upstream structure preserved: `grep -c "^## " …/SKILL.md` reads 4; `grep -c "^- \*\*" …/SKILL.md` reads 6 (three anti-patterns, three rules); `grep -c "tests.md" …/SKILL.md` reads ≥ 2 (the "See …" line and the attribution) and `grep -c "mocking.md" …/SKILL.md` reads ≥ 2.
- [ ] Line endings: `grep -c $'\r' packages/core/templates/skills/ralph-tdd/SKILL.md` reads 0, and likewise for `tests.md`, `mocking.md`, `LICENSE`.
- [ ] `grep -c "ralph-tdd" packages/core/src/__tests__/template-contract.test.ts` reads ≥ 1 (today 0); `grep -c 'describe("shipped skills"' packages/core/src/__tests__/template-contract.test.ts` reads 1.
- [ ] `git status --porcelain -- packages/core/src` lists only `packages/core/src/__tests__/template-contract.test.ts`; `git status --porcelain -- packages/core/templates` lists only the four new skill files.
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/template-contract.test.ts` green with at least 9 tests in the file (today 6), `pnpm --filter @daonhan/ralph-core typecheck` green, and `node scripts/smoke-templates.mjs` exits 0.

---

## Phase 2: Every stage mounts the skill and the implementer playbooks use it

**User stories**: 1, 2, 3, 5, 6, 7

### What to build

Implement the adapter surface, the two adapters' `skillsMount` and constants, the Claude `--add-dir` emission, `resolveSkillsMountArgs` + `RunStageOptions.skillsHostDir` in `runner.ts`, and the one-line `loop.ts` change — exactly as specified in Architectural decisions. Then change the `# IMPLEMENTATION` body of `prompt.md` and `ghprompt.md` to the exact playbook text.

Tests:

- `packages/core/src/__tests__/agents.test.ts`: in "Claude adapter", `getAgentAdapter("claude").skillsMount("/pkg/templates/skills")` `toEqual({ hostPath: "/pkg/templates/skills", containerPath: "/home/agent/ralph-skills/.claude/skills", readOnly: true })`; `adapter.buildCommand({ stage, promptInstruction, rawModel: "opus", codexUserConfig: false, home: "", skillsMounted: true })` has `args.slice(0, 4)` equal to `["claude", "--add-dir", "/home/agent/ralph-skills", "--verbose"]`; the same context with `skillsMounted: false` and with the field absent yields an argv that does not contain `"--add-dir"`. In the Codex section, `getAgentAdapter("codex").skillsMount("/pkg/templates/skills")` `toEqual({ hostPath: "/pkg/templates/skills", containerPath: "/home/agent/.agents/skills", readOnly: true })`, and `buildCodexArgs` with `skillsMounted: true` equals `buildCodexArgs` with `skillsMounted: false` for the same context. The existing "preserves the complete Claude argv" case stays byte-identical.
- `packages/core/src/__tests__/runner.test.ts`: a `describe("resolveSkillsMountArgs")` with a temporary directory: Claude → `["-v", `${dir}:/home/agent/ralph-skills/.claude/skills:ro`]`; Codex → `["-v", `${dir}:/home/agent/.agents/skills:ro`]`; a path that does not exist → `[]`; `undefined` → `[]`.
- `packages/core/src/__tests__/template-contract.test.ts`: `prompt.md` and `ghprompt.md` contain `` `ralph-tdd` `` and `For frontend UI code, implement directly.`; `review.md` contains neither.

### Acceptance criteria

- [ ] `grep -c "skillsMount(hostDir: string): AgentMount;" packages/core/src/agents/types.ts` reads 1 and `grep -c "skillsMounted?: boolean;" packages/core/src/agents/types.ts` reads 1 (today 0 each).
- [ ] `grep -c 'export const CLAUDE_SKILLS_ROOT = "/home/agent/ralph-skills";' packages/core/src/agents/claude.ts` reads 1; `grep -c -- '"--add-dir"' packages/core/src/agents/claude.ts` reads 1; `grep -c "skillsMount(" packages/core/src/agents/claude.ts` reads 1.
- [ ] `grep -c 'export const CODEX_SKILLS_ROOT = "/home/agent/.agents/skills";' packages/core/src/agents/codex.ts` reads 1; `grep -c "skillsMount(" packages/core/src/agents/codex.ts` reads 1; `grep -c "add-dir" packages/core/src/agents/codex.ts` reads 0; `grep -c "CODEX_SETUP_SCRIPT =" packages/core/src/agents/codex.ts` still reads 1 and `git diff main -- packages/core/src/agents/codex.ts | grep -c "^-[^-]"` reads 0 (nothing removed from the Codex adapter).
- [ ] `grep -c "export function resolveSkillsMountArgs" packages/core/src/runner.ts` reads 1; `grep -c "skillsHostDir" packages/core/src/runner.ts` reads ≥ 3; `grep -c "skillsMounted" packages/core/src/runner.ts` reads 1.
- [ ] `grep -c 'skillsHostDir: join(packageDir, "templates", "skills"),' packages/core/src/loop.ts` reads 1 and `git diff main -- packages/core/src/loop.ts | grep -c "^+[^+]"` reads 1 (one added line, nothing else).
- [ ] `grep -c '"claude"\|"codex"' packages/core/src/loop.ts` and `packages/core/src/render.ts` read what they read on `main` (`git show main:packages/core/src/loop.ts | grep -c '"claude"\|"codex"'` for the baseline): no provider branch was added outside `agents/`.
- [ ] Playbooks: `grep -c 'use the `ralph-tdd` skill' packages/core/templates/prompt.md` reads 1 and the same for `ghprompt.md`; `grep -c "For frontend UI code, implement directly." …/prompt.md` and `…/ghprompt.md` read 1 each; `grep -c "Complete the task." …/prompt.md` and `…/ghprompt.md` still read 1 each; `diff <(sed -n '/^# IMPLEMENTATION/,/^# FEEDBACK LOOPS/p' packages/core/templates/prompt.md) <(sed -n '/^# IMPLEMENTATION/,/^# FEEDBACK LOOPS/p' packages/core/templates/ghprompt.md)` prints nothing.
- [ ] `grep -c "ralph-tdd" packages/core/templates/review.md packages/core/templates/afk.md packages/core/templates/ghafk.md` reads 0 for each.
- [ ] Tests exist: `grep -c "skillsMount" packages/core/src/__tests__/agents.test.ts` reads ≥ 2; `grep -c -- '"--add-dir"' packages/core/src/__tests__/agents.test.ts` reads ≥ 1; `grep -c "resolveSkillsMountArgs" packages/core/src/__tests__/runner.test.ts` reads ≥ 2 (import + describe); `grep -c "ralph-tdd" packages/core/src/__tests__/template-contract.test.ts` reads ≥ 2 (Phase 1's skill block plus the playbook case).
- [ ] The pinned legacy argv is untouched: the `buildClaudeArgs(stage, ".ralph-tmp/prompt.md", ["--model", "opus"])` expectation in `agents.test.ts` still begins `"claude", "--verbose"` (`grep -A1 '^      "claude",$' packages/core/src/__tests__/agents.test.ts | grep -c '"--verbose"'` reads 1).
- [ ] Verification: `pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/agents.test.ts src/__tests__/runner.test.ts src/__tests__/template-contract.test.ts` green with at least 7 more tests than after Phase 1 across the three files, `pnpm --filter @daonhan/ralph-core typecheck` green, `node scripts/smoke-templates.mjs` exits 0.

### Handed to REVIEW (not runnable in BUILD's sandbox)

The live probe, run once on the host from the branch's built `dist/` (`pnpm -r build`, then the pack + `npm i -g` path from `CLAUDE.md` "Smoke-test the published artifacts locally", or run `apps/cli/bin/*` directly):

1. Mount check: `docker run --rm -v "<repo>\packages\core\templates\skills:/home/agent/.agents/skills:ro" docker.io/daonhan/ralph-sandbox:latest ls /home/agent/.agents/skills/ralph-tdd` lists the four files (the Windows host path form works).
2. Claude: in a scratch git repository outside this one (one commit, a `package.json` with `vitest`), run `ralph-afk "Add src/is-even.js exporting isEven(n) with tests" 1`. In `.ralph-tmp/logs/*-implementer.ndjson`, the `system`/`init` line's `skills` array contains `"ralph-tdd"`, and the stream shows either a `Skill` tool use naming `ralph-tdd` or a `Read` of `/home/agent/ralph-skills/.claude/skills/ralph-tdd/SKILL.md`.
3. Codex: same scratch repo, `ralph-afk --agent codex "…" 1`; the stream shows a tool item reading `/home/agent/.agents/skills/ralph-tdd/SKILL.md` (Codex emits no skills list; the read is the evidence).
4. Host side effects: after both runs `dir %USERPROFILE%\.claude\skills` shows no new entry, and `git status --porcelain` in the scratch repo lists only the agent's commit-tracked changes plus `.ralph-tmp/` and `.ralph/`.
5. If step 2's `skills` array lacks `ralph-tdd`, the fallback is the design session's rejected option (1): `@include` the skill into the playbooks and drop the mount — record the reading in the PR before choosing.

---

## Phase 3: Docs name the mount, the skill and how to add one

**User stories**: 6, 7, 8

### What to build

Docs only — no `src/`, template or skill change:

- `CLAUDE.md` and `AGENTS.md`, identical edits: in architecture item 4 (`runner.ts`) add that `runStage` also mounts the shipped skills directory (`templates/skills/`) read-only where the selected adapter's `skillsMount` says (Claude `/home/agent/ralph-skills/.claude/skills` + `--add-dir`, Codex `/home/agent/.agents/skills`); in item 5 (`agents/`) add `skillsMount` to the `AgentAdapter` member list; a new "Conventions to preserve" bullet starting `- **Shipped skills live in `packages/core/templates/skills/<name>/`.**` (mounted read-only into every stage; `SKILL.md` frontmatter `name` = directory name, prefixed `ralph-`; reference it from a playbook; extend the `shipped skills` block in `template-contract.test.ts`); one "Files for orientation" line for `packages/core/templates/skills/ralph-tdd/`. The numbered architecture list keeps ten items.
- `CONTEXT.md`: the `templates/` line of "Shape of the repo" mentions `skills/ralph-tdd/`; read-path item 7 mentions that the implementer playbooks call the shipped `ralph-tdd` skill.
- `docs/ARCHITECTURE.md`: in the `docker run` argv shape add `[ -v <core>/templates/skills:/home/agent/ralph-skills/.claude/skills:ro | :/home/agent/.agents/skills:ro ]` beside the credential-mount line; add `--add-dir /home/agent/ralph-skills` to the Claude argv block; a mounts bullet "**Shipped skills mount**" naming `skillsMount`, both container paths, read-only, and that no host directory is created; module-map rows for `agents/types.ts`, `agents/claude.ts`, `agents/codex.ts` mention the skills mount.
- `SECURITY.md`: one bullet after the credential-mounts bullet: the shipped skills directory (`templates/skills/` of the installed `@daonhan/ralph-core`) is bind-mounted **read-only**; it holds only Ralph's own files, no secrets, and the agent cannot modify it.
- `CONTRIBUTING.md`: a new `## Adding a shipped skill` section after "Customizing prompts": directory + frontmatter rules, the `ralph-` prefix and why, where each provider sees it, the test block to extend, `node scripts/smoke-templates.mjs`.
- `README.md`: a new `### Shipped skills` subsection under "Customizing the pipeline" (after "Change feedback loops or task priority"): what `ralph-tdd` is, that the implementer uses it for backend/library code, where it is mounted for each provider, and how to add another.

### Acceptance criteria

- [ ] `for f in README.md CONTRIBUTING.md CONTEXT.md CLAUDE.md AGENTS.md SECURITY.md docs/ARCHITECTURE.md; do grep -c "ralph-tdd" $f; done` prints a number ≥ 1 for every file (today 0 for all seven).
- [ ] `for f in CLAUDE.md AGENTS.md CONTRIBUTING.md docs/ARCHITECTURE.md README.md SECURITY.md; do grep -c "templates/skills" $f; done` prints ≥ 1 for every file (today 0).
- [ ] `grep -c -- "--add-dir /home/agent/ralph-skills" docs/ARCHITECTURE.md` reads ≥ 1; `grep -c "/home/agent/ralph-skills/.claude/skills:ro" docs/ARCHITECTURE.md` reads ≥ 1; `grep -c "/home/agent/.agents/skills:ro" docs/ARCHITECTURE.md` reads ≥ 1; `grep -c "skillsMount" docs/ARCHITECTURE.md` reads ≥ 3 (mounts bullet + module-map rows).
- [ ] `grep -c "^## Adding a shipped skill" CONTRIBUTING.md` reads 1; `grep -c "^### Shipped skills" README.md` reads 1; `grep -c "^- \*\*Shipped skills live in" CLAUDE.md` and `AGENTS.md` read 1 each; `grep -c "skills/ralph-tdd" CONTEXT.md` reads ≥ 1.
- [ ] `grep -ci "read-only" SECURITY.md` reads one more than `git show main:SECURITY.md | grep -ci "read-only"`.
- [ ] Twins: `diff <(grep -n "ralph-tdd\|templates/skills\|skillsMount" CLAUDE.md | cut -d: -f2-) <(grep -n "ralph-tdd\|templates/skills\|skillsMount" AGENTS.md | cut -d: -f2-)` prints nothing; `grep -c "^[0-9]\+\. \*\*" CLAUDE.md` reads 10 and the same for `AGENTS.md`.
- [ ] `git status --porcelain -- packages/core` prints nothing (docs-only phase).
- [ ] Verification: after LF-normalizing the files this phase touches (BUILD constraint above; on `main` four of the seven are CRLF in the working tree and fail `--check` for that reason alone), `pnpm exec prettier --check README.md CONTRIBUTING.md CONTEXT.md CLAUDE.md AGENTS.md SECURITY.md docs/ARCHITECTURE.md` green and `pnpm test` at the repo root green.

---

## Slice mapping

One pull request; one issue per phase, in dependency order: Phase 1 → Phase 2 → Phase 3 (Phase 3 documents Phases 1–2, so it lands last). Issue #147 is the tracker and is **closed by the PR merge**, not by an iteration.

| Phase | Issue                  |
| ----- | ---------------------- |
| 1     | #148                   |
| 2     | #149 (blocked by #148) |
| 3     | #150 (blocked by #149) |
