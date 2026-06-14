# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories — open the repository's
**[Security → Report a vulnerability](https://github.com/daonhan/ralph/security/advisories/new)**
form — or email **daonhan@gmail.com**. Include a description, reproduction steps, and the
affected version. You'll get an acknowledgement within a few days and a fix or mitigation plan.

## Supported versions

Only the latest published minor of each package (`@daonhan/ralph`, `@daonhan/ralph-core`) is
supported with security fixes. Pin by exact version if you need reproducibility.

## Threat model — read before running

Ralph is an **autonomous agent harness**. By design it runs the Claude Code CLI with
`--permission-mode bypassPermissions` directly on the host, so the agent executes bash, edits,
and tool calls **without interactive approval**. Treat everything it ingests as instructions it
may act on. The trust boundary is:

- **Only run Ralph against repositories, plans/PRDs, and GitHub issues you trust.** The plan/PRD
  string (`{{ INPUTS }}`), issue bodies/comments (`ralph-ghafk`), and commit messages are all
  fed to a `bypassPermissions` agent. `ralph-ghafk` in particular pulls **public GitHub issues**
  — text authored by strangers — into that agent. Do not point it at a repo whose open issues
  you have not vetted.

- **Blast radius depends on the runner.** The default `RALPH_RUNNER=sandbox` uses Claude Code's
  native OS sandbox (Seatbelt on macOS) to confine writes to the workspace tree, which is
  git-recoverable. `RALPH_RUNNER=host` runs unsandboxed — only safe in a throwaway tree.

- **Host credentials are accessible.** `claude` and `gh` on the host read `~/.claude`,
  `~/.claude.json`, and `~/.config/gh` directly. An agent running with `bypassPermissions`
  can read and overwrite those files. Use a scoped, short-lived `gh` token for untrusted inputs.

### Reducing blast radius

- Use the default `RALPH_RUNNER=sandbox` (native OS sandbox confines writes to the workspace).
- Run Ralph on a disposable VM / dedicated machine, not your primary workstation, for untrusted
  inputs.
- Review open issues before running `ralph-ghafk`.
- Use a scoped, short-lived `gh` token.

## Template authoring (contributors)

The prompt-template renderer (`render.ts`) executes the **command bodies** of the `` !`cmd` ``,
`` !?`cmd` ``, and `@spill` tags on the **host shell**. The shipped templates only ever use
**static** command strings, and `{{ INPUTS }}` is substituted last (written to a file the agent
reads, never re-shelled on the host) — so there is no host command-injection vector today.
**This invariant must be preserved:** never interpolate runtime or untrusted data into a tag
command body. Doing so would create direct host RCE.
