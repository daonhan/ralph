# PLAN / PRD

The plan and PRD are provided in the `<inputs>` block at the start of context — conventionally the paths to a plan file and a PRD file. `Read` them to get the work.

You've also been passed the last few commits in `<commits>`. Review them to understand what work has already been done.

Work through the plan/PRD tasks. If all of them are complete, output `<promise>NO MORE TASKS</promise>`.

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

# RECORDING PROGRESS

When a task is complete, record the outcome in your commit body, and update the plan file's status if it tracks one.

If a task is not complete, record the blocker in the commit body so the next iteration can pick up where you left off.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
