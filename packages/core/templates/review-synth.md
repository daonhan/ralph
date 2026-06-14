<head>

!?`git rev-parse HEAD|||(no commits)`

</head>

# REVIEW SYNTHESIS

Three review lenses (correctness / security / tests) each examined HEAD. Their findings are in `{{ FINDINGS_DIR }}` — `Read` every `findings-*.md` file there.

# ACTION

1. Dedupe the findings and discard false positives / non-issues.
2. If real defects remain, fix them in the working tree (only the latest commit's code — no unrelated changes), run the feedback loops:
   - Frontend / Node: `pnpm run test`, `pnpm run typecheck`
   - Backend / Dotnet: `dotnet test`, `dotnet build`
     then make a SINGLE commit: `git commit -am "fix(review): <short reason>"` (subject ≤72 chars, no `Co-Authored-By`, no file lists).
3. If nothing real remains, output `<review>OK</review>` and do **not** commit.

# RULES

- Never amend the implementer's commit — always a new `fix(review):` commit.
- Single pass. Do not loop.
