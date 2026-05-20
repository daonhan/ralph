# PLAN / PRD

A plan and/or PRD is provided at the start of context inside `<inputs>`. It describes
the work to be done — often as phases, user stories, or a checklist of acceptance
criteria. Parse it and treat it as the source of truth for what to build.

You've also been passed the last few commits inside `<commits>`. Read them to see what
has already been done so you do not repeat completed work.

If every task in the plan is complete — all acceptance criteria met and verified —
output `<promise>NO MORE TASKS</promise>` and stop.

# ORIENT

Before changing anything, read the repo's own guidance and honor it:

- `CLAUDE.md` / `AGENTS.md` (if present) — project-specific rules, conventions, and
  constraints take precedence over generic habits.
- `README.md` and existing code near what you're about to touch — match the
  surrounding style, module system, and import conventions.

# TASK SELECTION

Pick the single next task from the plan. Prioritize in this order:

1. Critical bugfixes
2. Development infrastructure (tests, types, dev scripts) — a precursor to features
3. Tracer bullets for new features — a tiny end-to-end slice through all layers
   first, then expand it out
4. Polish and quick wins
5. Refactors

# IMPLEMENTATION

Complete that one task. Keep the change scoped to it.

# FEEDBACK LOOPS (mandatory before committing)

Run the project's checks and read the output — do not assume success.

### Frontend / Node

- `pnpm -r typecheck` — type check
- `pnpm -r build` — build (skip only if there is no build script)
- `pnpm test` — run the tests

### Backend / Dotnet

- `dotnet build` — type-check
- `dotnet test` — run the tests

**If `dotnet build`/`dotnet test` fails with MSB3248** ("Could not resolve assembly
reference" / "file is corrupt") — this is a known virtiofs/9p I/O quirk when the repo
is mounted from the Windows host, NOT a code defect. Re-run with outputs redirected to
`/tmp` and parallelism disabled before treating it as red:

```bash
dotnet test <path-to-test-csproj> \
  -m:1 /p:UseSharedCompilation=false /p:BuildInParallel=false \
  /p:BaseIntermediateOutputPath=/tmp/ralph-obj/$(basename <path-to-test-csproj> .csproj)/ \
  /p:BaseOutputPath=/tmp/ralph-bin/$(basename <path-to-test-csproj> .csproj)/
```

Do not commit while anything is red. Only if a failure is genuinely outside the scope
of this task may you defer it — and then record the blocker in the commit body.

# COMMIT

Make a single `git commit -am` with a Conventional Commit message:

- Subject (≤72 chars): `<type>: <what changed>` where `<type>` is one of
  `feat`, `fix`, `perf`, `refactor`, `docs`, `ci`, `test`, `chore`. The type matters:
  repos commonly drive changelogs and release automation off it.
- Optional body (≤3 bullets): key decision, blocker for the next iteration.
- No file lists (git tracks them), no `Co-Authored-By`.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
