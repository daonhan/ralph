# @phamvuhoang/ralph-core

Library half of **[Ralph](https://github.com/phamvuhoang/ralph)** — a harness that drives the
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) CLI against a target
repository in an iterating implementer → reviewer loop, running directly on the host OS.

This package is the engine: the iteration loop driver, the runner + NDJSON stream
renderer, the prompt-template renderer, and the stage registry. The user-facing CLI lives in
**[`@phamvuhoang/ralph`](https://www.npmjs.com/package/@phamvuhoang/ralph)** (`ralph-afk` / `ralph-ghafk`).

> **Security:** Ralph runs Claude with `--permission-mode bypassPermissions`. Point it
> only at repositories and prompts you trust. See the repo's
> [SECURITY.md](https://github.com/phamvuhoang/ralph/blob/main/SECURITY.md).

## Install

```bash
npm i @phamvuhoang/ralph-core
```

## Use

```ts
import {
  runAfk,
  runGhAfk,
  runLoop,
  STAGES,
  renderTemplate,
} from "@phamvuhoang/ralph-core";

// Drive the plan/PRD loop from argv (same entry the ralph-afk bin uses):
await runAfk(["<plan-and-prd>", "5"]);
```

Public surface: `runAfk`, `runGhAfk`, `runLoop`, `STAGES`, `Stage`, `renderTemplate`,
`runStage`. Subpath exports: `./loop`, `./runner`, `./stages`.

`runStage` spawns `claude` directly on the host with `cwd` set to the workspace directory.
By default (`RALPH_RUNNER=sandbox`) it writes a transient `--settings` JSON that enables
the native OS sandbox, confining writes to the workspace. Set `RALPH_RUNNER=host` to run
unsandboxed. Credentials (`~/.claude`, `~/.config/gh`) are read natively — no bind-mounts
required. The `templates/` directory (prompt playbooks) ships in the tarball.

## Docs

Full usage, setup, environment variables, and architecture are in the
**[main README](https://github.com/phamvuhoang/ralph#readme)** and
**[docs/ARCHITECTURE.md](https://github.com/phamvuhoang/ralph/blob/main/docs/ARCHITECTURE.md)**.

## License

[MIT](https://github.com/phamvuhoang/ralph/blob/main/LICENSE) © Paul Nguyen.
