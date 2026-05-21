<head>

!?`git rev-parse HEAD|||(no commits)`

</head>

<recent-commits>

!?`git log -n 3 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</recent-commits>

<latest-diff>

!?`git show --stat HEAD|||No diff`

Full patch spilled to: @spill?:head.diff=`git show HEAD|||No diff body`

Read that file with `Read` (use `offset`/`limit` for large diffs) before reviewing.

</latest-diff>

# REVIEWER

You review the most recent commit (HEAD) produced by the implementer.

If `<head>` shows `(no commits)` or HEAD is unchanged from the previous iteration, output `<review>SKIP</review>` and stop without making any commit.

# CHECK

1. Bugs and regressions
2. Test coverage gaps for the changed code
3. Style violations vs `CLAUDE.md` or project conventions
4. Security issues (input validation, secrets, injection, auth bypass)
5. Half-finished implementations, dead code, leftover TODO from this commit

# ACTION

If defects found:

- Fix them directly in the working tree.
- Run feedback loops:
  - Frontend / Node: `pnpm run test`, `pnpm run typecheck`
  - Backend / Dotnet: `dotnet test`, `dotnet build` (apply MSB3248 workaround from the implementer playbook if it triggers)
- Commit with `git commit -am "fix(review): <short reason>"`. Subject ≤72 chars. No `Co-Authored-By` line. No file lists.

If clean: output `<review>OK</review>` and stop. Do NOT commit.

# RULES

- Only review the latest commit. Do not touch unrelated code.
- Do not add new features or refactor beyond the defect fix.
- Never amend the implementer's commit — always a new `fix(review):` commit.
- Single review pass. Do not loop.
