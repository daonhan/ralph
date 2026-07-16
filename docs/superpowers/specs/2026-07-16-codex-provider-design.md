# Codex Provider Design

- **Date:** 2026-07-16
- **Status:** Approved design
- **Scope:** Add Codex as an opt-in agent for both Ralph CLI workflows while preserving Claude as the default.

## Goal

Allow both existing commands to run their implementer and reviewer stages with
Codex:

```text
ralph-afk --agent codex "<plan-and-prd>" <iterations>
ralph-ghafk --agent codex <iterations>
```

An invocation that does not select an agent must continue to use Claude with
the existing behavior.

## Context

Ralph currently has a provider-neutral loop wrapped around a Claude-specific
runner:

1. run-bin.ts parses CLI input and invokes runLoop.
2. loop.ts renders each stage prompt, invokes runStage, and sentinel-checks the
   first stage's returned string.
3. runner.ts creates Docker arguments, mounts Claude credentials, invokes the
   Claude CLI, logs its JSON stream, and extracts its result event.
4. stream-render.ts understands and displays Claude's event schema.

The loop topology, templates, retry policy, wake lock, detach behavior,
notifications, Docker image lifecycle, and completion sentinel do not depend
on Claude. Provider support therefore belongs at the command, credential, and
stream-decoding boundary rather than in a duplicate loop.

## Requirements

### Selection and compatibility

- Claude remains the default agent.
- Both ralph-afk and ralph-ghafk accept --agent codex.
- Selection precedence is --agent, then RALPH_AGENT, then claude.
- Supported names are exactly claude and codex.
- A missing or unsupported --agent value fails before Docker starts.
- No new CLI binaries are introduced.
- Existing library calls remain source-compatible; new provider fields are
  optional and default to Claude.
- Detached runs preserve the selected agent because they replay the original
  argv.

### Codex authentication and configuration

- Codex reuses a host codex login session by mounting ~/.codex read-write at
  /home/agent/.codex.
- Ralph sets CODEX_HOME=/home/agent/.codex in the container.
- No OPENAI_API_KEY, CODEX_API_KEY, or other API-key handling is added.
- Codex runs ignore ~/.codex/config.toml by default while still using
  ~/.codex for authentication.
- --codex-user-config opts into the mounted user configuration.
- --codex-user-config with Claude is an invalid combination.
- Repository guidance such as AGENTS.md remains available through the mounted
  workspace in both Codex configuration modes.
- Documentation explains that host keyring-backed credentials are not
  available inside Docker; Ralph users need file-backed Codex credentials.

### Model precedence

RALPH_MODEL remains the only Ralph model override and applies to the selected
agent.

For Claude:

- A non-empty RALPH_MODEL retains the existing --model pass-through.
- An unset, empty, or whitespace-only value retains the Claude CLI default.

For Codex:

1. A non-empty RALPH_MODEL is passed verbatim, after trimming, as
   --model <value>. Ralph does not validate or silently replace it.
2. With no RALPH_MODEL and --codex-user-config, Ralph supplies no model or
   reasoning override; the mounted user configuration owns both.
3. With no RALPH_MODEL in isolated mode, Ralph supplies
   --model gpt-5.6-sol and model_reasoning_effort="high".

If an explicit or default Codex model is unavailable, the Codex run fails and
uses Ralph's existing retry/error path. Ralph does not launch a second run with
a different model because the failed stage may already have modified the
workspace.

### Shared playbooks

- Claude and Codex use the same afk.md, ghafk.md, prompt.md, ghprompt.md, and
  review.md templates.
- The reviewer rule that currently names only CLAUDE.md is normalized to
  check AGENTS.md, CLAUDE.md, and repository conventions.
- No provider-specific prompt copies are added.
- The first-stage sentinel remains <promise>NO MORE TASKS</promise>.

## Architecture

### Provider modules

Create packages/core/src/agents/ with four focused modules:

- types.ts defines AgentName, adapter input types, mount declarations,
  normalized render events, and decoder results.
- claude.ts owns Claude command construction, Claude credential mounts, and
  translation of Claude JSON events.
- codex.ts owns Codex command construction, the Codex credential mount, and
  translation of Codex JSONL events.
- index.ts validates an AgentName and returns the corresponding adapter.

The adapter contract has three responsibilities:

1. Build the provider command appended after the Docker image reference.
2. Declare provider-specific credential mounts and container environment.
3. Create a stateful decoder that maps raw JSON objects to normalized render
   events and reports completion or failure.

Adapters do not spawn processes, touch tempfiles, render templates, own retry
policy, or inspect the completion sentinel.

### Shared runner

runner.ts continues to own:

- prompt and spill tempfiles;
- common Docker arguments and the workspace mount;
- the read-only GitHub CLI configuration mount;
- Docker socket detection, warning, and mounting;
- child-process spawning and cancellation;
- raw NDJSON logging;
- stderr-tail collection;
- the RALPH_RESULT_GRACE_MS timer; and
- cleanup.

runStage selects the adapter from its optional RunStageOptions.agent value,
which defaults to claude. RunStageOptions gains codexUserConfig alongside its
existing signal field. This avoids changing the exported runStage positional
signature.

LoopOptions gains optional agent and codexUserConfig fields. runLoop passes
them to every stage and otherwise remains provider-neutral. Direct library
callers that omit both fields continue to use Claude.

The flow is:

```text
runBin
  -> resolve --agent / RALPH_AGENT and config flags
  -> runLoop
  -> render shared stage template
  -> runStage
  -> selected AgentAdapter
       - command
       - selected credentials
       - JSON decoder
  -> shared Docker process and normalized renderer
  -> final message string
  -> existing first-stage sentinel gate
```

### Credential mount minimization

Only the selected provider's credentials are exposed to the container:

- Claude mounts ~/.claude and ~/.claude.json exactly as today.
- Codex mounts ~/.codex read-write.
- Both may mount ~/.config/gh read-only.

This is narrower than mounting both providers on every run. The Codex mount
must remain writable because Codex can refresh file-backed login tokens during
use.

## CLI Contract

The shared parser gains:

```text
--agent <claude|codex>
--codex-user-config
```

RALPH_AGENT is the environment equivalent of --agent. The explicit flag wins.
An invalid selected name is reported with the supported values.

The effective settings passed into runLoop are:

```text
agent: "claude" | "codex"
codexUserConfig: boolean
```

Help output documents the flags, RALPH_AGENT, selected-agent semantics for
RALPH_MODEL, and Codex's isolated default. --print-config reports:

- selected agent and its source;
- Codex configuration mode when Codex is selected;
- resolved model and its source; and
- reasoning source, including high for the isolated Sol default.

Claude print-config text remains equivalent except that its model line is
described as the selected CLI's model rather than globally as a Claude-only
setting.

## Provider Commands

### Claude

The Claude adapter preserves the current argument order and semantics:

```text
claude
  --verbose
  --print
  --output-format stream-json
  [--permission-mode <stage permission mode>]
  [--model <RALPH_MODEL>]
  "<instruction to read the rendered prompt file>"
```

The default Claude path is protected with exact argv regression tests.

### Codex

The Codex adapter builds:

```text
codex exec
  --json
  --ephemeral
  --dangerously-bypass-approvals-and-sandbox
  [--ignore-user-config]
  [--model <resolved model>]
  [-c model_reasoning_effort="high"]
  "<instruction to read the rendered prompt file>"
```

--ignore-user-config is present unless --codex-user-config was selected.
Codex's dangerous bypass is intentional: Ralph is an unattended workflow and
the process already runs inside the externally supplied Docker boundary. This
matches the existing Claude bypassPermissions contract.

The isolated Sol/high pair is supplied only when RALPH_MODEL is absent.
When RALPH_MODEL is present, the adapter supplies the explicit model without
adding Ralph's high-effort default. In inherited configuration mode, all
non-model user settings remain available and an explicit RALPH_MODEL still
wins over the user-configured model.

Codex runs use --ephemeral so each Ralph stage remains a fresh session and no
session rollout is persisted into the host ~/.codex mount.

## Stream Normalization

stream-render.ts becomes provider-neutral. It receives normalized events for:

- initialization;
- assistant text;
- reasoning;
- tool start;
- tool completion;
- diagnostics;
- completion; and
- failure.

The Claude decoder maps the existing system, assistant, user/tool_result, and
result records to that representation without changing visible output or
final-result behavior.

The Codex decoder recognizes:

- thread.started and turn.started as initialization diagnostics;
- item.started and item.completed records for reasoning, command execution,
  file changes, MCP calls, web searches, plan activity, and agent messages;
- turn.completed as successful terminal completion;
- turn.failed and error as provider failures.

Every stdout JSON line is appended verbatim to the stage NDJSON log before
decoding. Unknown top-level event types and unknown item types remain logged
and are otherwise ignored so additive Codex schema changes do not crash Ralph.

The Codex decoder retains the latest completed agent_message text. On
turn.completed, that text becomes the stage result returned to runLoop. A
successful process exit without both turn.completed and a final agent message
is an incomplete Codex stream and rejects the stage. Claude retains its
current completion semantics for backward compatibility.

When a decoder reports successful completion, streamDocker arms the existing
RALPH_RESULT_GRACE_MS timer. For Claude this corresponds to result; for Codex
it corresponds to turn.completed. If the child does not exit before the timer,
Ralph kills it and resolves with the already captured final message.

Provider failures reject the stage even if the Docker child later exits with
status 0. A non-zero Docker exit retains the existing stderr-tail diagnostic.
The existing retry policy owns all rejected stages.

## Sandbox Image

The single packages/core/templates/Dockerfile installs both CLIs. Claude
remains the image CMD so direct legacy image use is unchanged.

The Codex package is pinned as:

```text
@openai/codex@0.144.4
```

Pinning is deliberate because Ralph consumes Codex's JSONL event contract.
Updating the pin requires the adapter fixtures and image smoke contract to
pass. The image smoke test verifies codex --version and checks that codex exec
exposes --json, --ephemeral, --ignore-user-config, --model, and
--dangerously-bypass-approvals-and-sandbox.

## Security

The existing Ralph threat model continues to apply:

- Both agents run non-interactively with approval checks bypassed.
- The workspace is writable.
- The selected provider's reusable credentials are readable by processes
  inside the container.
- A mounted Docker socket grants root-equivalent control of the host Docker
  daemon.

Documentation must explicitly state that ~/.codex/auth.json is a secret and
that selecting isolated configuration does not hide credentials from the
agent; it only prevents personal config, MCP, hook, and model settings from
loading. RALPH_DOCKER_SOCK=0 remains the control for removing host Docker
daemon access.

Inherited Codex configuration may reference host-only paths or commands that
do not exist in the Linux image. A required MCP server or hook failure is a
stage failure; Ralph does not silently fall back to isolated configuration.

## Error Handling

- Invalid agent names and invalid flag combinations fail before image setup.
- Missing or unusable Codex authentication surfaces through the Codex CLI and
  the existing Docker stderr-tail error.
- Explicit model failures never trigger a model substitution.
- The isolated Sol/high default has no secondary model fallback.
- Codex turn.failed and error events preserve their message in the thrown
  stage error.
- Unknown JSON events are tolerated and retained in raw logs.
- Malformed known records cannot produce a false successful Codex completion.
- Abort signals kill the active Docker child for either provider and preserve
  current SIGINT/SIGTERM behavior.

## Test Strategy

### CLI tests

Cover:

- no selection resolves to Claude;
- RALPH_AGENT=codex selects Codex;
- --agent wins over RALPH_AGENT;
- missing and unsupported values fail;
- --codex-user-config succeeds with Codex and fails with Claude;
- both bin entry paths forward the same resolved options;
- help and print-config show the agreed model/config precedence; and
- detach argv retains both new flags.

### Adapter tests

Claude tests assert the complete current argv and credential mounts.

Codex argument tests cover:

- isolated mode with no RALPH_MODEL: Sol/high plus
  --ignore-user-config;
- inherited mode with no RALPH_MODEL: no model, effort, or
  --ignore-user-config override;
- isolated mode with explicit RALPH_MODEL: explicit model, no Sol fallback;
- inherited mode with explicit RALPH_MODEL: explicit model while user config
  remains enabled;
- empty and whitespace RALPH_MODEL handling;
- prompt-file instruction placement; and
- ~/.codex and CODEX_HOME declarations.

Mount tests prove that Claude credentials are absent from Codex runs and Codex
credentials are absent from Claude runs.

### Decoder and renderer tests

Fixture-driven tests cover documented Codex JSONL examples and representative
Claude records:

- assistant output;
- reasoning;
- successful and failed commands;
- file changes;
- MCP and web-search activity;
- final agent-message extraction;
- turn completion;
- turn failure and error records;
- unknown event and item types;
- successful exit without a Codex completion record;
- completion without a final agent message; and
- post-completion grace-timer behavior.

Renderer assertions verify that assistant text goes to stdout while tool and
diagnostic events go to stderr.

### Loop and image tests

- Loop tests assert that agent/config options reach every runStage call and
  that either adapter's returned final string uses the unchanged first-stage
  sentinel gate.
- Image tests assert the pinned Codex installation and required exec flags.
- The normal repository verification remains:

```text
pnpm -r typecheck
pnpm -r test
pnpm test
pnpm -r build
```

- Image verification builds packages/core/templates/Dockerfile and runs the
  repository image smoke script.
- An authenticated manual smoke runs one bounded ralph-afk Codex iteration
  against a disposable Git repository, confirms JSONL logging and live output,
  and confirms a sentinel response stops before the reviewer.

## Documentation and Packaging

Update:

- README.md;
- packages/core/README.md;
- apps/cli/README.md;
- docs/ARCHITECTURE.md;
- SECURITY.md;
- CONTRIBUTING.md where stage/runner extension guidance is Claude-specific;
- CLI help and print-config output;
- package descriptions and keywords; and
- the Ralph architecture visual where it labels the runtime Claude-only.

The documentation covers:

- installing and logging into Codex;
- same-shell host path behavior on PowerShell, WSL, Linux, and macOS;
- file-backed Codex authentication;
- --agent and RALPH_AGENT precedence;
- isolated and inherited Codex configuration;
- RALPH_MODEL behavior and the Sol/high isolated default;
- security implications of ~/.codex and docker.sock;
- common authentication, model, config-path, MCP, and JSONL failures; and
- local published-artifact smoke testing with Codex present in the image.

Package metadata adds Codex/OpenAI discoverability without removing existing
Claude keywords. Generated changelogs remain release-please-owned and are not
edited as part of this feature.

## Alternatives Rejected

### Provider conditionals throughout runner.ts

This initially touches fewer files but mixes two command formats, credential
models, terminal-event definitions, and stream schemas into an already large
runner. The resulting conditionals would be harder to test and extend.

### Separate Codex runner and image

This isolates dependencies but duplicates tempfiles, Docker mounts, socket
handling, cancellation, retries, logs, grace timers, release publishing, and
documentation. The operational cost is disproportionate for two CLI providers
with the same lifecycle.

### Codex SDK

The SDK adds a runtime dependency and another lifecycle abstraction while
Ralph already needs the CLI inside Docker. codex exec --json supplies the
required non-interactive streaming boundary directly.

## Success Criteria

The feature is complete when:

1. Existing invocations still select Claude and pass all existing tests.
2. Both bins accept --agent codex and run the same stage topology.
3. Codex reuses file-backed host login without loading user config by default.
4. --codex-user-config intentionally enables the full mounted Codex config.
5. Model precedence matches the agreed three-case contract.
6. Codex's final agent message drives the unchanged completion sentinel.
7. Live output, NDJSON logs, cancellation, retries, and grace handling work for
   both providers.
8. Only selected-provider credentials are mounted.
9. The published sandbox contains the pinned, smoke-tested Codex CLI.
10. User-facing and maintainer documentation describes setup, behavior,
    security, and troubleshooting.

## Official Codex References

- Authentication: https://learn.chatgpt.com/docs/auth
- Non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- CLI command reference:
  https://learn.chatgpt.com/docs/developer-commands?surface=cli
- Configuration basics:
  https://learn.chatgpt.com/docs/config-file/config-basic
- Models: https://learn.chatgpt.com/docs/models
