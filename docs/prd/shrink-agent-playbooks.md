# PRD: Shrink Ralph Agent Playbooks

> **Status (2026-06): partially superseded — not implemented as written.** The
> cross-file duplication this PRD targets has since been removed by factoring the
> shared playbook body into `packages/core/templates/playbook-common.md`
> (`@include`d by both `afk.md` and `ghafk.md`), not via the `_task-ladder.md` /
> `_feedback-loops.md` / `_commit-format.md` snippet files this document proposes —
> those do not exist. Treat the snippet design below as historical.

## Context

User wants iteration context windows smaller so the in-container Claude agent stays focused on the task. Investigation showed each stage already runs in a fresh `--rm` Docker container with a fresh `claude --print` session (runner.ts:206-247, loop.ts:36-72) — so the per-stage context budget is already isolated. The remaining lever is the **prompt itself**: the playbooks shipped at `packages/core/templates/*.md` carry redundant prose, cross-file duplication, and verbose explanations of concepts the agent already knows.

A cold audit of the 5 templates (`prompt.md`, `ghprompt.md`, `afk.md`, `ghafk.md`, `review.md`, total ~238 lines / ~7.3 KB) found ~1 KB of cleanly recoverable text without dropping any load-bearing rule.

## Problem Statement

As a Ralph user, every iteration the agent burns input tokens re-reading the same 5-tier task ladder, the same feedback-loop commands, the same commit-format rules, and a 12-line paragraph re-defining "tracer bullet" — all of which are duplicated across two implementer playbooks and partially restated in the reviewer playbook. That prose competes for context window space against the things that actually matter for the current task: the issue body, the diff under review, the workspace files the agent is reading.

I want the playbooks to be terse, deduplicated, and edit-once.

## Solution

Extract the duplicated blocks into small shared snippet files under `packages/core/templates/`, then `@include:` them from the three playbooks. The existing `@include:` machinery (render.ts:49-52) already supports this — no renderer changes needed.

From the user's perspective:

- Rendered prompts shrink ~60% in line count, ~40% in characters, without changing observable behaviour.
- Each rule lives in exactly one snippet file. Editing the commit-message format updates implementer **and** reviewer in one commit.
- The `<promise>NO MORE TASKS</promise>` sentinel string stays verbatim (hardcoded at loop.ts:17).
- Existing `afk.md` / `ghafk.md` iteration wrappers do not change — they continue to `@include` the implementer playbooks, which now in turn `@include` the snippets.

## User Stories

1. As a Ralph user, I want each iteration to spend fewer input tokens on boilerplate playbook text, so that more of the model's context window is free for the task-relevant issue body, diff, and code.
2. As a Ralph user, I want the agent's commit-message rules to be defined in exactly one place, so that fixing a typo or adding a rule does not require editing three files and remembering to keep them in sync.
3. As a Ralph user, I want the task-prioritisation ladder ("bugfixes → infrastructure → tracer bullets → polish → refactors") defined once, so that the implementer and gh-implementer cannot drift apart.
4. As a Ralph user, I want the feedback-loop command list (`pnpm run test`, `pnpm run typecheck`, `dotnet test`, `dotnet build`) defined once, so that adding a new check (e.g. `pnpm run lint`) propagates to every stage that runs it.
5. As a Ralph user reading the reviewer template, I want it to be short enough to skim in one screen, so that I can quickly understand what the reviewer agent is going to do.
6. As a Ralph user with a Node-only target repo, I want the .NET MSB3248 quirk paragraph to stay available (because the sandbox does ship .NET) but not bloat the default path, so that Node-only iterations are not penalised by a 12-line .NET workaround block.
7. As a Ralph user, I want "tracer bullets" defined in one line, not four, so that the agent re-reading the playbook spends bytes on the work, not the vocabulary lesson.
8. As a Ralph user, I want hedging phrasing ("you will work on", "you've also been passed", "you review") replaced with direct imperatives, so that the playbook reads as instructions rather than orientation.
9. As a Ralph user, I want the existing `<promise>NO MORE TASKS</promise>` completion sentinel preserved exactly, so that the loop's gate logic in `loop.ts` keeps working unchanged.
10. As a Ralph user, I want `{{ INPUTS }}` substitution and `@spill` / `@include` / `!?` shell tags to keep working unchanged, so that the renderer contract is not broken.
11. As a Ralph maintainer, I want shared snippets to be conventionally named (e.g. `_task-ladder.md` with a leading underscore), so that they are visibly distinct from top-level playbooks and won't be confused for entrypoint templates.
12. As a Ralph maintainer, I want every snippet file to be listed in `packages/core/package.json`'s `files` array via the existing `templates/` glob, so that they ship in the published npm tarball with no manifest edits required.
13. As a Ralph maintainer, I want the `renderTemplate` function to be exercised by a real test on the new snippet wiring, so that I have automated confidence that `@include:_task-ladder.md` resolves correctly relative to its including template's directory.
14. As a Ralph maintainer, I want the test to use Node's built-in `node:test` runner (already wired as `pnpm test` in the root `package.json`), so that no new test framework dependency is introduced.
15. As a Ralph maintainer, I want the test file compiled by the existing `tsc -p tsconfig.json` pipeline, so that I write `.test.ts` next to `render.ts` and the existing build emits the runnable `dist/render.test.js`.
16. As a Ralph maintainer, I want a `pnpm -r test` invocation to find and execute these tests, so that `pnpm install && pnpm -r build && pnpm -r test` is the canonical local verification path.
17. As a Ralph maintainer, I want each playbook (`prompt.md`, `ghprompt.md`, `review.md`) to retain its own front-matter sections that _are_ genuinely different (issues view, sentinel emission, commit-vs-skip behaviour), so that the dedup work doesn't accidentally flatten meaningful differences.
18. As a Ralph maintainer, I want a render-diff snapshot of the fully-expanded prompts before vs after the change, captured in the PR description, so that the reviewer can see that no load-bearing rule was dropped.
19. As a Ralph user running `ralph-afk --print-config`, I want that command's output to be unaffected, so that the change is scoped strictly to template content.
20. As a Ralph user, I want the `gh issue list` / `gh issue list --json` spill paths (ghafk.md:9-15) to be unchanged, so that the GitHub-issue iteration loop keeps working.
21. As a Ralph user, I want `<head>` / `<recent-commits>` / `<latest-diff>` blocks at the top of `review.md` preserved, so that the reviewer continues to receive the git context it needs to make a fix-vs-OK decision.

## Implementation Decisions

### New shared-snippet modules

Three snippet files added under `packages/core/templates/`. Leading underscore signals "fragment, not entrypoint":

- **`_task-ladder.md`** — the 5-tier prioritisation list ("Critical bugfixes → Development infrastructure → Tracer bullets → Polish and quick wins → Refactors"). One-line gloss per tier; tracer-bullet definition compressed from 4 lines to 1.
- **`_feedback-loops.md`** — the Node + .NET test/typecheck command list, plus the MSB3248 workaround block (condensed from 12 lines to ~5 with the same load-bearing flags). Both playbooks and the reviewer include this; .NET section is kept inline because removing it would require either a build-time switch or a separate Node-only snippet — out of scope.
- **`_commit-format.md`** — subject ≤72 chars, optional ≤3-bullet body, no file lists, no `Co-Authored-By`. Shared by all three playbooks.

### Modified files

- **`packages/core/templates/prompt.md`** — replace TASK SELECTION body with `@include:_task-ladder.md`, replace FEEDBACK LOOPS body with `@include:_feedback-loops.md`, replace COMMIT body with `@include:_commit-format.md`. Strip hedging ("You will work on", "You've also been passed") to imperatives. Target ~25 lines.
- **`packages/core/templates/ghprompt.md`** — same three `@include:` substitutions. Keep the dual `<issues-summary>` / `<issues-full-file>` documentation block that explains how to use them (this is the genuine differentiator from `prompt.md`). Target ~25 lines.
- **`packages/core/templates/review.md`** — replace the inline feedback-loop block (lines 43-44) with `@include:_feedback-loops.md`, replace inline commit-rule sentence (line 45) with `@include:_commit-format.md`. The `<head>` / `<recent-commits>` / `<latest-diff>` shell-tag prelude and the REVIEWER / CHECK / ACTION / RULES sections stay as-is, just tightened. Target ~30 lines.

### Unchanged

- `packages/core/templates/afk.md` and `ghafk.md` — already minimal wrappers (13 and 21 lines). No edits.
- `packages/core/src/render.ts` — `@include:` already supports relative-path resolution against the including template's directory (render.ts:49-52); no renderer changes needed.
- `packages/core/src/loop.ts` and `runner.ts` — untouched. Sentinel string stays at `loop.ts:17`.
- `packages/core/package.json` — `files: ["dist", "templates", ...]` already ships everything under `templates/`. No edits.
- `apps/cli/bin/*.js` — untouched.
- `packages/core/templates/Dockerfile` — untouched.

### Renderer contract — no changes

The existing `@include:` regex (`render.ts:8`) matches `@include:<path>` and resolves relative paths against the including template's directory. Nested includes (a snippet `@include`ing another snippet) are **not** supported by the current implementation — the renderer makes a single pass. The proposed snippet files are all leaves (no transitive includes), so this limitation does not bite, but it is worth recording so future edits don't introduce a cycle that silently no-ops.

### Naming convention

Files starting with `_` are conventionally treated as partials in other template ecosystems (Sass, Jekyll, Hugo). Adopting this here makes the entrypoint-vs-fragment distinction visually obvious in `ls`. They still ship via the `templates/` directory in the npm tarball — no special handling.

## Testing Decisions

### What makes a good test here

The renderer's contract is its **input → output mapping**: given a template path and a set of vars, it returns the expanded string. A good test asserts on that contract — never on the intermediate AST, never on private regex internals, never on side effects beyond what the function is documented to do.

### Modules under test

- **`packages/core/src/render.ts`** — the `renderTemplate` function. Specifically the `@include:` path-resolution behaviour, since the snippet refactor leans on it.

### Test plan

Single test file at `packages/core/src/render.test.ts`:

1. **`@include:` resolves a sibling snippet** — write a fixture template that does `@include:_fixture-snippet.md`, write the snippet next to it, assert the expanded output contains the snippet's body.
2. **`@include:` with `{{ INPUTS }}` in the parent** — confirm that `{{ INPUTS }}` substitution still happens after include expansion (matters because the renderer does include-first, then inputs-last per render.ts:49 vs render.ts:136).
3. **`@include:` of a real shipped snippet** — point at `packages/core/templates/_task-ladder.md` (after it exists), render `prompt.md`, assert the output contains "Critical bugfixes" and "Refactors" (anchor lines from the ladder). This is the "did the refactor actually wire up" test.
4. **Sentinel string survives rendering** — render `prompt.md`, assert the output still contains the exact literal `<promise>NO MORE TASKS</promise>` (regression guard for the loop's gate logic).

Test file is `.ts`, compiled by the existing `tsc -p tsconfig.json` into `dist/render.test.js`, executed by `node --test dist/**/*.test.js`. Root `package.json` already declares `"test": "node --test"` (line 12); a per-package script can wrap this as `node --test dist/**/*.test.js` and `pnpm -r test` will pick it up.

### Prior art

The repo has no existing test files — this introduces the first one. The simplicity of `node:test` (no framework, no transformer, no config) is deliberately chosen to keep the cost of "the first test" tiny and avoid the typical "we added Vitest and now CI is 90s slower" tax. See the root `package.json` line 12: `"test": "node --test"` is already plumbed in.

### Manual verification path

1. `pnpm install && pnpm -r build && pnpm -r typecheck && pnpm -r test`
2. Eyeball: render `afk.md` and `ghafk.md` manually (small Node script in `packages/core/dist/` or a one-off `node -e`), grep the rendered output for: "Critical bugfixes", "pnpm run test", "≤72 chars", "<promise>NO MORE TASKS</promise>". All four must be present.
3. Smoke: `RALPH_WORKSPACE=<some-fixture-repo> ralph-afk "" 1` against a trivial fixture (e.g. a repo with one closed issue), confirm the iteration banner prints, the rendered prompt in `<workspaceDir>/.ralph-tmp/.run-*.md` is shorter than before, and the agent still picks up and either completes or emits the sentinel.
4. Capture the before/after rendered-prompt diff in the PR body so a human reviewer can confirm no load-bearing rule was dropped.

## Out of Scope

- Splitting the `_feedback-loops.md` snippet into Node-only and .NET-flavoured variants (would require a build-time switch or a per-target conditional include — the renderer doesn't support conditionals today). The .NET section is kept inline in the shared snippet; future work can introduce conditional includes if a Node-only mode becomes valuable.
- Changing the renderer (`render.ts`) — no nested includes, no conditionals, no template inheritance. The point of this PRD is to use the existing machinery better.
- Touching `apps/cli/bin/*.js`, `loop.ts`, `runner.ts`, `stages.ts`, or `Dockerfile`.
- Modifying the `<promise>NO MORE TASKS</promise>` sentinel or any other loop-gate semantics.
- Adding a lint/CI step that enforces "no duplicated H1 across templates" — nice-to-have, separate PRD.
- Changing which directories get bind-mounted into the container (credential mounts at `runner.ts:219-233` stay as-is).

## Further Notes

- **The MSB3248 workaround stays.** It is load-bearing (the sandbox image mounts the host workspace via virtiofs/9p on Windows, which trips this real .NET MSBuild bug). Compressing the 12-line explanation to ~5 lines is fine; deleting it is not.
- **Reviewer keeps the `<head>` / `<recent-commits>` / `<latest-diff>` prelude.** Those shell tags + spill are how the reviewer agent gets its git context — not boilerplate.
- **`ghprompt.md`'s dual-view issues section is the differentiator** from `prompt.md`. It must stay inline in `ghprompt.md`; do not extract it.
- **Hedging-vs-imperative.** Phrases like "You will work on AFK issues only, not the HITL ones" carry a real rule (the label filter). Rewrite to imperative ("Work on `afk` issues only. Skip `hitl`.") rather than deleting.
- **Sentinel guard test** (#4 above) is the cheap regression check that catches any future edit that silently strips the completion marker from the rendered prompt.
- **PR description should include the before/after rendered-prompt diff** — produced by rendering `afk.md` and `ghafk.md` against a fixture workspace at HEAD and at the PR tip. This is the human-readable proof that the change was substance-preserving.

## Critical Files

Modified:

- `packages/core/templates/prompt.md`
- `packages/core/templates/ghprompt.md`
- `packages/core/templates/review.md`

Created:

- `packages/core/templates/_task-ladder.md`
- `packages/core/templates/_feedback-loops.md`
- `packages/core/templates/_commit-format.md`
- `packages/core/src/render.test.ts`

Untouched but referenced (don't break):

- `packages/core/src/render.ts` (the `@include:` regex at line 8, the include-expansion loop at lines 49-52)
- `packages/core/src/loop.ts` (sentinel at line 17)
- `packages/core/templates/afk.md` and `ghafk.md` (wrappers)
- `packages/core/package.json` (`files: ["dist", "templates", ...]` already covers the new snippets)
- Root `package.json` (`"test": "node --test"` at line 12 already wires the runner)
