# @daonhan/ralph-core

Library half of **[Ralph](https://github.com/daonhan/ralph)** — a harness that drives the
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) CLI against a target
repository in an iterating implementer → reviewer loop, inside an ephemeral Docker sandbox.

This package is the engine: the iteration loop driver, the Docker runner + NDJSON stream
renderer, the prompt-template renderer, and the stage registry. The user-facing CLI lives in
**[`@daonhan/ralph`](https://www.npmjs.com/package/@daonhan/ralph)** (`ralph-afk` / `ralph-ghafk`).

> **Security:** Ralph runs Claude with `--permission-mode bypassPermissions` inside the sandbox
> and, by default, bind-mounts the host Docker socket (root-equivalent host access). Point it
> only at repositories and prompts you trust. See the repo's
> [SECURITY.md](https://github.com/daonhan/ralph/blob/main/SECURITY.md).

## Install

```bash
npm i @daonhan/ralph-core
```

## Use

```ts
import {
  runAfk,
  runGhAfk,
  runLoop,
  STAGES,
  renderTemplate,
} from "@daonhan/ralph-core";

// Drive the plan/PRD loop from argv (same entry the ralph-afk bin uses):
await runAfk(["<plan-and-prd>", "5"]);
```

Public surface: `runAfk`, `runGhAfk`, `runLoop`, `STAGES`, `Stage`, `renderTemplate`,
`ensureImage`, `runStage`. Subpath exports: `./loop`, `./runner`, `./stages`.

The `templates/` directory (prompt playbooks + the `ralph-sandbox` `Dockerfile`) ships in the
tarball and is the default `docker build` fallback context.

## Docs

Full usage, setup, environment variables, and architecture are in the
**[main README](https://github.com/daonhan/ralph#readme)** and
**[docs/ARCHITECTURE.md](https://github.com/daonhan/ralph/blob/main/docs/ARCHITECTURE.md)**.

## License

[MIT](https://github.com/daonhan/ralph/blob/main/LICENSE) © Paul Nguyen.
