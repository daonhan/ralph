# PRD: Ship a `ralph-tdd` Agent Skill and mount it into the sandbox

> Tracks GitHub issue #147. The design was fixed in a 2026-09-10 design session (goal → skill choice → delivery mechanism → location → wiring → content → name → playbook wording → knobs → verification → execution path); the decisions below are its record, not options.

## Problem Statement

Ralph's templates never use Agent Skills. The implementer playbooks (`prompt.md`, `ghprompt.md`) carry a one-line `# IMPLEMENTATION` section — "Complete the task." — so the test discipline the loop should follow (a failing test first, the minimum code to pass it, one vertical slice per cycle, tests at public seams) has no home in Ralph. Whatever discipline an iteration shows comes from the model's defaults.

The skills a Ralph user already has on the host reach the sandbox only by accident. The `system`/`init` event of a `ralph-ghafk` iteration on 2026-09-09 (sandbox Claude Code 2.1.266, `.ralph-tmp/logs/2026-09-09T05-13-16-707Z-iter4-ghafk-implementer.ndjson`) listed **3** skills out of the ~80 under the host's `~/.claude/skills` — exactly the three that are real directories. The other 77 are NTFS junctions into `~/.agents/skills`; their `C:\...` targets dangle inside the Linux bind mount of `~/.claude`. The same event showed `plugins: []`: `installed_plugins.json` stores Windows `installPath`s the container cannot open. For Codex the situation is simpler and worse: the setup script copies only `auth.json`, `config.toml` and `AGENTS.md` into the container-local `CODEX_HOME`, so `~/.codex/skills` never reaches the sandbox at all.

So a playbook cannot say "use the `tdd` skill" today: on the primary host (Windows + Docker Desktop) the skill is not there, on other hosts it is there only if that user installed it, and for Codex it is never there.

## Solution

Ralph ships **one Ralph-owned skill**, `ralph-tdd`, inside `@daonhan/ralph-core`, mounts the shipped skills directory **read-only into every stage** for both providers, and tells the implementer playbooks to use it for backend and library code. The skill body is not inlined into the prompt: the agent sees the skill's name and description and reads `SKILL.md` (and its two reference files) only when it uses it.

Concretely, for a workspace stage the `docker run` line gains one mount, and the Claude argv one flag:

```
# Claude
-v <core>/templates/skills:/home/agent/ralph-skills/.claude/skills:ro
… claude --add-dir /home/agent/ralph-skills --verbose --print --output-format stream-json …

# Codex
-v <core>/templates/skills:/home/agent/.agents/skills:ro
… codex exec --json --ephemeral … (argv unchanged)
```

`<core>` is the installed `@daonhan/ralph-core` directory — the `packageDir` the loop already resolves to read `templates/<stage>.md`.

**Why these two container paths.** Claude Code loads `<dir>/.claude/skills/*/SKILL.md` for every `--add-dir <dir>` as project-source skills (`code.claude.com/docs/en/skills.md`, "Skills from additional directories"); `/home/agent/ralph-skills` is a container-local path outside every host bind mount, so no directory is ever created on the host (a nested mount under the `~/.claude` bind would create `~/.claude/skills/<name>/` on the host). Codex scans `$HOME/.agents/skills` as a User-scope skill root, and keeps scanning it under `--ignore-user-config` and `--ephemeral` (verified against `codex-rs/core-skills/src/loader.rs` at tag `rust-v0.144.0`, the version the image pins; `--ignore-user-config` drops only the user `config.toml` table). Neither path is inside the workspace bind mount, so nothing lands in the target repository either.

**What the agent sees.** Claude: `ralph-tdd` appears in the init event's `skills` array and is invokable through the Skill tool. Codex: every turn's developer-role catalog carries `- ralph-tdd: <description> (file: /home/agent/.agents/skills/ralph-tdd/SKILL.md)`, and a plain-text mention of the skill name in the prompt makes its use mandatory for that turn. The playbook sentence "use the `ralph-tdd` skill" therefore works unchanged for both providers.

**Every stage, one playbook.** The mount is unconditional (whenever the shipped directory exists) and identical for implementer and reviewer stages — one code path, no per-stage condition. Only the implementer playbooks reference the skill; `review.md` is untouched.

**Cost.** One `-v` argument per stage, one flag for Claude, and at most ~7 KB read on demand. No environment knob: a read-only mount of Ralph's own files needs no off switch.

## User Stories

1. As a Ralph user on any OS, I want the implementer to follow a red → green loop for backend and library code, so that the tests it commits verify behavior at public seams instead of being an afterthought — without installing anything on my host.
2. As a Windows Ralph user, I want that skill to work even though my own `~/.claude/skills` entries are junctions the container cannot follow, so that the loop's discipline does not depend on my host layout.
3. As a Codex Ralph user, I want the same skill with the same wording, so that switching `--agent` changes the model and not the method.
4. As a Ralph user who has my own `tdd` skill installed, I want Ralph's reference to be unambiguous, so that the playbook never resolves to an interactive skill that asks a user who is not there.
5. As a Ralph user on a frontend-heavy repository, I want UI code to be implemented directly, so that markup and styling are not forced through a unit-test-first loop where it adds little.
6. As a Ralph maintainer, I want to add another shipped skill by dropping a directory with a `SKILL.md` next to `ralph-tdd/`, so that no runner or adapter change is needed per skill.
7. As a Ralph maintainer, I want the provider-specific container paths and the Claude flag to live in `agents/` with unit-tested argv, so that `loop.ts` and `runner.ts` stay provider-neutral.
8. As a security-conscious Ralph user, I want the new mount to be read-only, to contain only Ralph's own shipped files, and to be listed in `SECURITY.md`, so that the sandbox's host exposure is unchanged.
9. As the reviewer stage (and the next iteration), I want the implementer to list the seams it chose to test in the commit body, so that a test-shape decision made with no user present is visible and checkable.
10. As a Ralph maintainer, I want the skill content to stay diffable against its upstream (pinned commit, minimal edits, license kept), so that upstream improvements can be pulled in without re-deriving Ralph's adaptations.

## Implementation Decisions

- **Skill files.** `packages/core/templates/skills/ralph-tdd/` holds exactly four files: `SKILL.md`, `tests.md`, `mocking.md`, `LICENSE`. Source: [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/tdd/` at commit `321658273cb1d20b76026717d027d505790106d4` (2026-08-19), MIT. `tests.md`, `mocking.md` and the repository `LICENSE` are copied byte-for-byte. Upstream's `agents/openai.yaml` (Codex display metadata) is not shipped. The directory already lives inside the tarball's `files` entry `templates/` and, like the playbooks, inside the `ralph-sandbox` release-please component (`packages/core/templates`), so a skill-only commit bumps the sandbox component, not `ralph-core` — the same trade the playbooks already make.
- **`SKILL.md` adaptations** (exactly four edits against upstream; everything else verbatim):
  1. Frontmatter: `name: ralph-tdd`; `description: Test-driven implementation for a Ralph iteration. Use when implementing backend or library code: one failing test, the minimum code to make it pass, repeat per vertical slice, tests at public seams.` — under Codex's 1024-character cap, phrased for catalog matching rather than for a user's request.
  2. The seams paragraph and its follow-up question (upstream lines 22–24, "**Test only at pre-agreed seams.** … confirm them with the user … Ask: …") become one paragraph: the run is unattended, there is no user to ask; write down the seams under test before the first test and keep to them; list them in the commit body so the reviewer stage and the next iteration can see the choice; naming seams up front is still how testing effort lands on critical paths instead of every edge case.
  3. The paragraph pointing at the `codebase-design` skill (upstream line 26) is removed: that skill is not shipped, and a pointer to an absent skill is noise.
  4. The last rule (upstream line 38) reads "It belongs to Ralph's reviewer stage, not the red → green implementation cycle." — `code-review` is not shipped either, and Ralph has its own reviewer stage.
     Directly under the H1, one attribution line names the upstream repository, path, license and commit, and states in a clause why the copy differs (unattended run).
- **Adapter contract** (`agents/types.ts`). `AgentAdapter` gains `skillsMount(hostDir: string): AgentMount` — where this provider discovers skills, always `readOnly: true`. `AgentCommandContext` gains `skillsMounted?: boolean` — set by the runner when the mount was added, so a provider that needs a flag emits it only when the directory it points at exists in the container.
- **Claude** (`agents/claude.ts`). `CLAUDE_SKILLS_ROOT = "/home/agent/ralph-skills"`; `skillsMount` returns `{ hostPath, containerPath: CLAUDE_SKILLS_ROOT + "/.claude/skills", readOnly: true }`. With `skillsMounted`, the argv is `claude --add-dir /home/agent/ralph-skills --verbose --print …`: `--add-dir <directories...>` is **variadic** (`claude --help`), so it must be followed by a boolean flag — placed anywhere after `--model <m>` it would swallow the prompt positional whenever the model flag is omitted (third-party routing). The legacy export `buildClaudeArgs(stage, promptPath, modelArgs)` keeps its exact argv (no `--add-dir`); only the adapter's `buildCommand` path reads the flag.
- **Codex** (`agents/codex.ts`). `CODEX_SKILLS_ROOT = "/home/agent/.agents/skills"`; `skillsMount` returns that path read-only. `buildCodexArgs` ignores `skillsMounted`: Codex discovers the root by scanning. The credential setup script is untouched.
- **Runner** (`runner.ts`). New `resolveSkillsMountArgs(adapter, skillsHostDir)` returns `["-v", "<host>:<container>:ro"]` when `skillsHostDir` is set and exists on the host, else `[]` — the same `existsSync` guard `resolveAgentRuntimeArgs` applies to credential paths. `RunStageOptions` gains `skillsHostDir?: string`; `runStage` appends the mount after the provider's credential mounts and passes `skillsMounted: args.length > 0` into `buildCommand`. Host paths go through `join`, so on Windows the spec is `C:\…\templates\skills:/home/agent/…:ro`, the form the credential mounts already use.
- **Loop** (`loop.ts`). The `runStage` call passes `skillsHostDir: join(packageDir, "templates", "skills")` — one added property; no other change.
- **Playbooks.** In `prompt.md` and `ghprompt.md`, the `# IMPLEMENTATION` body becomes, identically: "For backend or library code, use the `ralph-tdd` skill: one failing test, the minimum code to make it pass, repeat per vertical slice. For frontend UI code, implement directly. Complete the task." The frontend split mirrors the maintainer's `do-work` skill; `review.md` does not change.
- **Naming.** `ralph-tdd`, not `tdd`. On macOS/Linux a user's personal `~/.claude/skills/tdd` resolves inside the container and would sit beside a project-source `tdd`; Codex injects a `$name` mention only when exactly one enabled skill has that name. A `ralph-` prefix makes the playbook reference deterministic for both providers and marks the copy as Ralph-adapted. Future shipped skills follow the same prefix.
- **No knob, no `--print-config` line, no Dockerfile change, no `@include`.** `RALPH_SKILLS=0` / `RALPH_SKILLS_DIR` and per-run skill injection are a separate feature with their own questions (merge vs replace, path validation).
- **Documentation.** `CLAUDE.md` / `AGENTS.md` (identical edits: the `runner.ts` and `agents/` architecture items, a new "Shipped skills" convention bullet, an orientation line — the numbered list stays at ten), `CONTEXT.md` (repo shape and read path), `docs/ARCHITECTURE.md` (argv shape, mounts bullet, module-map rows), `SECURITY.md` (the new read-only mount), `CONTRIBUTING.md` (a short "Adding a shipped skill" section), `README.md` (a "Shipped skills" subsection under "Customizing the pipeline").

## Testing Decisions

- **What makes a good test here.** The adapters and the runner helper are pure functions from `(hostDir, flags)` to mount records and argv arrays; tests assert on those arrays with literal expected values, the way `agents.test.ts` already pins the complete Claude argv and `runner.test.ts` builds a temporary home for `resolveAgentRuntimeArgs`. The skill content has a contract — frontmatter Claude and Codex both parse, no interactive phrasing, reference files present — that a template-contract test pins the way `template-contract.test.ts` pins the `<history>` block. Whether Claude Code actually lists the skill and whether Codex actually reads it are only observable in a real run: that is the review session's probe, not a unit test.
- **Modules under test.** `agents/claude.ts`, `agents/codex.ts` (existing suite `agents.test.ts`); `runner.ts` (existing suite `runner.test.ts`); the shipped templates and skill (existing suite `template-contract.test.ts`).
- **Cases, adapters.** Claude `skillsMount("/pkg/templates/skills")` equals `{ hostPath: "/pkg/templates/skills", containerPath: "/home/agent/ralph-skills/.claude/skills", readOnly: true }`; Codex equals the same with `containerPath: "/home/agent/.agents/skills"`. Claude `buildCommand` with `skillsMounted: true` starts `["claude", "--add-dir", "/home/agent/ralph-skills", "--verbose"]`; with the flag absent or `false` the argv contains no `--add-dir`. Codex `buildCodexArgs` returns the same argv with the flag `true` and `false`. The existing "preserves the complete Claude argv" case is unchanged.
- **Cases, runner.** `resolveSkillsMountArgs(claude, <existing temp dir>)` equals `["-v", "<dir>:/home/agent/ralph-skills/.claude/skills:ro"]`; for Codex `["-v", "<dir>:/home/agent/.agents/skills:ro"]`; a non-existent path and `undefined` both give `[]`.
- **Cases, skill and playbooks.** `SKILL.md` frontmatter has `name: ralph-tdd` and a non-empty `description` shorter than 1024 characters; the body contains neither "confirm them with the user" nor "codebase-design" nor "`code-review`"; `tests.md`, `mocking.md`, `LICENSE` exist beside it. `prompt.md` and `ghprompt.md` contain "`ralph-tdd`" and "For frontend UI code, implement directly."; `review.md` contains neither. `node scripts/smoke-templates.mjs` still renders all three templates.
- **Handed to REVIEW** (the sandbox has no Docker CLI, and BUILD cannot start a nested ralph run): the live probe — a scratch repository, one `ralph-afk` iteration per provider from the branch's built `dist/`, the Claude init event's `skills` array containing `ralph-tdd`, a Codex tool item reading `/home/agent/.agents/skills/ralph-tdd/SKILL.md`, and the host's `~/.claude/skills` and the scratch tree unchanged afterwards.

## Out of Scope

- Fixing host-skill plumbing: junction resolution, `installed_plugins.json` path translation, copying `~/.codex/skills` into `CODEX_HOME`.
- `RALPH_SKILLS=0`, `RALPH_SKILLS_DIR`, or any per-run skill injection (a later slice if wanted).
- Vendoring the skill into the prompt with `@include`.
- A reviewer-stage skill (`code-review` or similar); `review.md` is unchanged.
- Shipping `do-work`: its plan → implement → validate → commit shape is already `prompt.md` / `ghprompt.md`, and its "ask the user" steps contradict an unattended run.
- A `--print-config` line for the mount; Dockerfile or `images/pg17/` changes.
- Any other shipped skill; `ralph-tdd` is the tracer.

## Further Notes

Evidence gathered on 2026-09-10 on the primary host (Windows 11, Docker Desktop, image `docker.io/daonhan/ralph-sandbox:latest`):

1. **Host skill layout.** `dir /a %USERPROFILE%\.claude\skills` shows 77 `<JUNCTION>` entries targeting `C:\Users\<user>\.agents\skills\<name>` and three `<DIR>` entries (`graphify`, `next-slice`, `slice-cycle`). The sandbox init event's `skills` array listed exactly those three (plus bundled skills) and `plugins: []`.
2. **Claude Code facts** (`code.claude.com/docs/en/skills.md`, `cli-reference.md`, `settings-reference.md`): skills load in `--print` mode; `--add-dir <path>` loads `<path>/.claude/skills/`; `--plugin-dir` exists but needs a plugin manifest; there is no settings key or env var naming extra skill directories; symlinked skill directories are followed (junctions to host paths are not resolvable from the container regardless).
3. **Codex facts** (docs `learn.chatgpt.com/docs/build-skills`; source at tag `rust-v0.144.0`, the image's pinned 0.144.4 differing only in non-skill patches): roots are `<project>/.agents/skills` from cwd up to the `.git` root, `.codex/skills`, `$CODEX_HOME/skills` (deprecated, still scanned), `$HOME/.agents/skills`, `/etc/codex/skills`, and the bundled `.system`; `codex exec` loads them; the catalog is injected each turn within a 2 % context / 8 000-character budget; `$name` or a plain-text mention injects `SKILL.md`; duplicates by name are both kept and a `$name` mention then injects nothing; no JSONL event lists loaded skills; `CODEX_HOME` must stay writable (bundled skills are installed at startup) — Ralph's container-local `CODEX_HOME` already is.
4. **`--add-dir` is variadic**: `claude --help` prints `--add-dir <directories...>`. The flag consumes following non-option tokens, hence its position before `--verbose`.
5. **Upstream skill.** Local copies of `tests.md` / `mocking.md` matched upstream `3216582` byte-for-byte; the local `SKILL.md` predated three upstream wording edits and the added `codebase-design` paragraph, which is why the vendored copy is taken from the pinned upstream commit, not from a host copy.

BUILD constraints carried over from this repository's `.ralph/history/` (2026-09-09 run):

- The workspace is a CRLF checkout on a Windows bind mount. New files are written LF; changed files are staged by explicit path (no `git commit -am`) and committed with `-c core.hooksPath=/dev/null`, because the husky hook cannot run in the sandbox.
- The sandbox has no Docker CLI: anything that needs `docker run` or a live Claude/Codex session is REVIEW's item.
- `cli-help.test.ts` has been prettier-dirty since `930e445` — pre-existing, out of scope.

Stress-test & provoke:

- Killer assumption: [solution] a `--add-dir` root's `.claude/skills` is loaded in `--print` mode inside the container → documented; observed only for personal and bundled skills so far, hence the REVIEW probe. If it fails, the fallback is the `@include` vendoring rejected in the design session (template-only change, same skill text, no mount).
- Other assumptions: [feasibility] Codex keeps scanning `$HOME/.agents/skills` under `--ignore-user-config` (source-verified at the pinned tag); [user] a frontend/backend split is the right default for TDD in AFK; [problem] the 3-of-80 reading generalizes to every Windows host that installs skills through junctions.
- Strongest counter: inline the skill with `@include` and skip the mount — simpler, but it triples the playbook, leaves `tests.md` / `mocking.md` unreachable, and stops being a skill the agent can load on demand.
- Would be unnecessary if: Claude Code and Codex shared one on-disk skill root that a plain volume could serve — they do not (`.claude/skills` vs `.agents/skills`), which is exactly why the path lives in the adapter.
