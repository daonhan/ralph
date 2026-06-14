# ISSUES

Two views of open GitHub issues are provided at the start of context:

- `<issues-summary>` — inline lean index (number, title, labels). Use this to triage and pick a task.
- `<issues-full-file>` — path to a spilled JSON file containing bodies + comments. `Read` that file (with `offset`/`limit` if it is large) once you have picked an issue you want to act on.

You will work on the AFK issues only, not the HITL ones. Label filtering uses the `labels` field in the summary.

You've also been passed a file containing the last few commits. Review these to understand what work has been done.

If all AFK tasks are complete, output <promise>NO MORE TASKS</promise>.

# TASK SELECTION

Pick the next task. Prioritize tasks in this order:

1. Critical bugfixes
2. Development infrastructure

Getting development infrastructure like tests and types and dev scripts ready is an important precursor to building features.

3. Tracer bullets for new features

Tracer bullets are small slices of functionality that go through all layers of the system, allowing you to test and validate your approach early. This helps in identifying potential issues and ensures that the overall architecture is sound before investing significant time in development.

TL;DR - build a tiny, end-to-end slice of the feature first, then expand it out.

4. Polish and quick wins
5. Refactors

# EXPLORATION

Explore the repo.

# IMPLEMENTATION

Complete the task.

# FEEDBACK LOOPS

Before committing, run the feedback loops:

### Frontend / Node

- `pnpm run test` to run the tests
- `pnpm run typecheck` to run the type checker

### Backend / Dotnet

- `dotnet test` to run the tests
- `dotnet build` to type-check

**If `dotnet test` or `dotnet build` fails with MSB3248** ("Could not resolve assembly reference" / "file is corrupt") — this is a known virtiofs/9p I/O quirk when the repo is mounted from the Windows host. It is NOT a code defect. Do not defer verification. Re-run with build outputs redirected to `/tmp` and parallelism disabled:

```bash
dotnet test <path-to-test-csproj> \
  -m:1 \
  /p:UseSharedCompilation=false \
  /p:BuildInParallel=false \
  /p:BaseIntermediateOutputPath=/tmp/ralph-obj/$(basename <path-to-test-csproj> .csproj)/ \
  /p:BaseOutputPath=/tmp/ralph-bin/$(basename <path-to-test-csproj> .csproj)/
```

Only if that second attempt also fails may you defer and record the blocker in the commit message.

# COMMIT

Make a single `git commit -am` with a short message:

- Subject line (≤72 chars): what changed
- Optional body (≤3 bullets): key decision, blocker for next iteration
- No file lists (git tracks them), no `Co-Authored-By`

# THE ISSUE

If the task is complete, close the original GitHub issue.

If the task is not complete, leave a comment on the GitHub issue with what was done.

# LEARNINGS

The repo's accumulated learnings are in the `<learnings>` block — durable, reusable knowledge from prior iterations (conventions, gotchas, decisions and their why, dead ends). Consult it during EXPLORATION and IMPLEMENTATION so you don't relearn what's known or repeat a dead end.

If, while doing the task, you discover a NEW durable, reusable learning — a repo convention, a non-obvious gotcha, a decision and its why, or a dead-end to avoid — append it tersely to the right section of `./.ralph/LEARNINGS.md`. Create the file if it does not exist, with these four sections:

```

# Ralph learnings

## Conventions

## Gotchas

## Decisions

## Dead ends

```

Dedupe against existing entries and prune anything no longer true. This file is committed WITH your task commit (it is git-tracked) — do NOT make a separate commit for it. The bar is durable AND reusable: do NOT record routine or one-off task details.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
