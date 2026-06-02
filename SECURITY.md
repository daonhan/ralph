# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories — open the repository's
**[Security → Report a vulnerability](https://github.com/daonhan/ralph/security/advisories/new)**
form — or email **daonhan@gmail.com**. Include a description, reproduction steps, and the
affected version. You'll get an acknowledgement within a few days and a fix or mitigation plan.

## Supported versions

Only the latest published minor of each package (`@daonhan/ralph`, `@daonhan/ralph-core`) and
the latest `ralph-sandbox` image are supported with security fixes. Pin by digest for the image
and by exact version for the packages if you need reproducibility.

## Threat model — read before running

Ralph is an **autonomous agent harness**. By design it runs the Claude Code CLI with
`--permission-mode bypassPermissions` inside the sandbox container, so the agent executes
bash, edits, and tool calls **without interactive approval**. Treat everything it ingests as
instructions it may act on. The trust boundary is:

- **Only run Ralph against repositories, plans/PRDs, and GitHub issues you trust.** The plan/PRD
  string (`{{ INPUTS }}`), issue bodies/comments (`ralph-ghafk`), and commit messages are all
  fed to a `bypassPermissions` agent. `ralph-ghafk` in particular pulls **public GitHub issues**
  — text authored by strangers — into that agent. Do not point it at a repo whose open issues
  you have not vetted.

- **The host Docker socket is bind-mounted by default**, which grants the sandbox
  **root-equivalent access to the host Docker daemon** (it can start a sibling container that
  bind-mounts the host filesystem as root). This is on so Testcontainers inside the sandbox can
  spawn sibling containers. **Disable it with `RALPH_DOCKER_SOCK=0`** when running anything you
  do not fully trust. With it disabled, the blast radius is bounded to the bind-mounted
  workspace tree (git-recoverable).

- **Host credentials are bind-mounted.** `~/.claude` and `~/.claude.json` are mounted
  **read-write** (Claude refreshes its OAuth token by writing back), so the agent can read and
  overwrite your Claude credentials. `~/.config/gh` is mounted read-only.

### Reducing blast radius

- Set `RALPH_DOCKER_SOCK=0` unless you specifically need Testcontainers.
- Run Ralph on a disposable VM / dedicated machine, not your primary workstation, for untrusted
  inputs.
- Review open issues before running `ralph-ghafk`.
- Use a scoped, short-lived `gh` token.

## Template authoring (contributors)

The prompt-template renderer (`render.ts`) executes the **command bodies** of the `` !`cmd` ``,
`` !?`cmd` ``, and `@spill` tags on the **host shell**. The shipped templates only ever use
**static** command strings, and `{{ INPUTS }}` is substituted last (written to a file the agent
reads inside the container, never re-shelled on the host) — so there is no host command-injection
vector today. **This invariant must be preserved:** never interpolate runtime or untrusted data
into a tag command body. Doing so would create direct host RCE.
