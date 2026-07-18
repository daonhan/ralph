# @daonhan/ralph-core

Library half of **[Ralph](https://github.com/daonhan/ralph)** — a harness that drives Claude
Code by default, or Codex when selected with `--agent codex`, against a target repository in
an iterating implementer → reviewer loop inside an ephemeral Docker sandbox.

This package is the engine: the iteration loop driver, the Docker runner + NDJSON stream
renderer, the prompt-template renderer, and the stage registry. The user-facing CLI lives in
**[`@daonhan/ralph`](https://www.npmjs.com/package/@daonhan/ralph)** (`ralph-afk` / `ralph-ghafk`).

> **Security:** Ralph runs the selected agent without interactive approval inside the sandbox
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

// Select Codex for this invocation (Claude is the default):
await runAfk(["--agent", "codex", "<plan-and-prd>", "5"]);
```

The CLI equivalent is `ralph-afk --agent codex "<plan-and-prd>" 5` (or
`ralph-ghafk --agent codex 5`). `RALPH_AGENT=codex` provides an environment fallback.
See the root README's [Codex login](https://github.com/daonhan/ralph#codex-login) and
[provider selection](https://github.com/daonhan/ralph#choose-the-coding-agent) sections,
including isolated configuration, `--codex-user-config`, and model precedence.

Public surface: `runAfk`, `runGhAfk`, `AgentName`, `AgentSelection`,
`AgentSelectionSource`, `runLoop`, `LoopOptions`, `STAGES`, `Stage`, `renderTemplate`,
`RenderOptions`, `RenderVars`, `ensureImage`, `runStage`.
Subpath exports: `./loop`, `./runner`, `./stages`.

The `templates/` directory (prompt playbooks + the `ralph-sandbox` `Dockerfile`) ships in the
tarball and is the default `docker build` fallback context.

## Docs

Full usage, setup, environment variables, and architecture are in the
**[main README](https://github.com/daonhan/ralph#readme)** and
**[docs/ARCHITECTURE.md](https://github.com/daonhan/ralph/blob/main/docs/ARCHITECTURE.md)**.
Read the full [security threat model](https://github.com/daonhan/ralph/blob/main/SECURITY.md)
before running either provider.

## License

[MIT](https://github.com/daonhan/ralph/blob/main/LICENSE) © Paul Nguyen.
