# Plan: Codex Ultra effort in Ralph

> Source PRD: [Codex Ultra effort](../prd/codex-ultra-effort.md).
> Slice ID: `codex-ultra-effort` · one issue, one implementation phase, one PR.
> Execution: a **separate task** using the installed slice-cycle worker (0.8.0, contract v1). BUILD and product repairs are owned by `ralph-ghafk`, launched through the plugin companion. This document is not permission for the planning task to implement or launch BUILD.

**Goal:** Accept Codex Ultra through the existing effort interface and explain model compatibility without changing defaults.

**Architecture:** Extend Codex's effort allowlist and reuse the current resolver, argv builder and diagnostics. Preserve provider-neutral orchestration and Codex-owned model compatibility.

**Stack:** Node >=20, pnpm >=9, ESM TypeScript, Vitest, Docker, Codex CLI; no new dependencies.

## Global constraints

- User-selected scope: Ultra support + compatibility docs. Sol/high remains the isolated default; both stages use one tuning object.
- Per-field precedence: CLI flag, provider-specific variable, generic variable, then existing adapter/config behavior.
- Codex's effort set becomes `none|minimal|low|medium|high|xhigh|max|ultra`; Claude and the shared set remain unchanged.
- The actual Codex argv must contain `model_reasoning_effort="ultra"`. No translation to `max`, custom subagent flags, or delegation prompt.
- Keep model strings unrestricted and let Codex reject unavailable combinations. Preserve existing failure/retry behavior; no silent fallback.
- No new `await` before the first stage, no event schema change, no credential/mount/image changes, no product code in `apps/cli`.
- Runtime and queue state belongs in the separate worker's ignored checkpoint, not in these committed documents.
- Ralph's implementer delegates the product-docs pass to a subagent per repository guidance; keep `AGENTS.md` and `CLAUDE.md` guidance synchronized. The slice-cycle coordinator reviews those edits and routes repairs back through Ralph; it does not implement product documentation itself or through its own subagent.

## Verified baseline and source evidence

Planning baseline: `4e90253992cab3126cc8f7569243a420b2ce6cac`; main; core 0.17.0 / CLI 0.7.1. Model/effort work (#161, #162) is already closed. Read-only pagination of open issues on 2026-09-22 found no open implementation issues or ready-for-agent queue (one unrelated dependency PR); recheck at execution time.

Relevant code:

| Boundary                                            | Existing owner                      |
| --------------------------------------------------- | ----------------------------------- |
| Effort allowlist, defaults and Codex command        | `packages/core/src/agents/codex.ts` |
| Per-field resolution and provider/shared validation | `packages/core/src/agents/index.ts` |
| Help, print-config and resolved event fields        | `packages/core/src/cli-help.ts`     |
| Bin forwarding                                      | `packages/core/src/run-bin.ts`      |
| Single-run tuning, both stages and durable errors   | `packages/core/src/loop.ts`         |
| Direct-stage validation and Docker argv             | `packages/core/src/runner.ts`       |

Local `codex --version` returned 0.154.0. `codex debug models --bundled` advertised Ultra for Astra/Sol/Terra and not Luna; see the dated table in the PRD. OpenAI's [model guide](https://learn.chatgpt.com/docs/models) and [subagent effort guide](https://learn.chatgpt.com/docs/agent-configuration/subagents#reasoning-effort-model_reasoning_effort) support the existing `model_reasoning_effort` path. The generated 0.154.0 app-server schema describes ReasoningEffort as a nonempty string; a schema/config parser accepting a string alone is not a compatibility check. No live model smoke was performed during planning.

The worker must read the current repository instructions, PRD, this plan, and the [adversary review](../reviews/codex-ultra-effort-plan-review.md), then compare the actual base with this baseline. Reconcile conflicts instead of replaying stale instructions.

## Review focus

1. A provider-only value must not leak into generic `RALPH_EFFORT`; test the Codex-specific hint and unchanged shared set.
2. An explicit non-Ultra effort must beat an Ultra environment value; inherited configuration must not become a source of Ralph defaults.
3. A gate that emits the sentinel skips the reviewer; the two-stage tuning test must move HEAD and avoid the sentinel to exercise both stages.
4. Config output and logs report the requested setting, not account entitlement or the inherited effective effort; use exact source assertions.
5. Accepting a string or passing a unit test does not prove the sandbox client can execute it; U9 requires real client completion in a scratch workspace.

## Phase 1: Select, run and observe Codex Ultra

**User stories:** 1–6. **Acceptance:** U1–U9. This is one vertical delivery from input to sandbox argv to operator output, including tests and docs. It has no prerequisite issue within the slice.

### Implementation and test steps

- [ ] Add focused failing cases to the existing test suites. Start with an explicit expected behavior that is red on the baseline:

  ```ts
  expect(
    validateAgentTuning("codex", {
      effort: { value: "ultra", source: "--effort" },
    })
  ).toBeUndefined();
  ```

  Then cover the acceptance matrix below at its owning seam. Use the current fixtures and public function signatures. Run each affected suite red before changing its behavior.

- [ ] In `agents/codex.ts`, add `"ultra"` to `codexAdapter.effortLevels`. Keep `DEFAULT_CODEX_MODEL` and `DEFAULT_CODEX_REASONING_EFFORT` unchanged. Existing `resolveCodexModel` and `buildCodexArgs` should already pass the value through. Expected emitted pair:

  ```ts
  ["-c", 'model_reasoning_effort="ultra"'];
  ```

  Add a brief comment that Ultra is a Codex mode with model-dependent support. Do not add a model allowlist or runtime discovery module.

- [ ] Update `cli-help.ts` to name `ultra` among Codex-only choices and explain model-dependent support. Valid Ultra config output and existing event fields should follow from the allowlist; change those implementations only if a behavioral test demonstrates a gap.

- [ ] Update literal invalid-Codex-level expectations to include the new allowed value. Preserve the distinction between unknown `ultracode` and valid Codex `ultra`, and retain Claude's existing `ultracode` exclusion.

- [ ] Verify the matrix, implement only demonstrated gaps, and delegate the documentation pass described below. Keep unrelated cleanup out of the diff.

### Acceptance test matrix

| Cases                        | Suite / externally observable assertions                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1/U2: flag and provider env | `agents.test.ts`: literal Ultra accepted for Codex; provider env source is exact; flag `low` beats env `ultra`; trimmed `" ultra "` accepted after resolution; blank flag falls through. `run-bin.test.ts` / `cli-help.test.ts`: existing two entrypoint configurations preserve `--effort ultra`.                                                    |
| U3: wrong provider/source    | `agents.test.ts`: explicit Claude Ultra rejected; generic Ultra rejected for both providers with `RALPH_CODEX_EFFORT=ultra` hint; provider-specific value ignored by Claude; shared set remains the five current literals.                                                                                                                            |
| U4/U7: command and defaults  | `agents.test.ts`: exact argument pair for explicit and env-resolved Ultra, isolated and inherited modes; isolated keeps ignore-user-config; inherited untuned model is omitted; Sol/high defaults and explicit-model/high regression cases remain green. An arbitrary model ID is preserved. No `max` substitution or additional delegation switches. |
| U5: diagnostic output        | `cli-help.test.ts`: Ultra from flag/env has the correct source and no invalid suffix; generic/Claude Ultra is marked invalid without throwing; help names the Codex-only mode. Isolate and restore all relevant tuning environment variables.                                                                                                         |
| U6: durable loop behavior    | `loop.test.ts`: one iteration with a HEAD-moving gate and no sentinel runs both stages, carrying the same explicit Ultra tuning; `run.started` has `effort: "ultra"`, correct source and unchanged model. Add env-source event coverage. Wrong-source Ultra logs `run.ended error` and never calls ensureImage/runStage.                              |
| U7: error retention          | Keep existing no-fallback and decoder-failure tests green; add a focused case only if those tests do not show that an explicit requested value is retained across the existing failure/retry path. No change to retry classification.                                                                                                                 |
| U8: docs                     | Review every current Codex effort list, unchanged default, examples and model-compatibility caveat against the final argv and test evidence.                                                                                                                                                                                                          |
| U9: real sandbox             | Run the bounded scratch smoke below, using the built candidate core and a supported authenticated Codex client. Record fresh evidence at the final feature head.                                                                                                                                                                                      |

### Product documentation

The delegated docs pass updates `README.md` (model/effort section and environment table), `docs/ARCHITECTURE.md` (accepted values/argv and ownership), and the corresponding model/effort paragraphs in both `AGENTS.md` and `CLAUDE.md`. Update `QUICKSTART.md`/`CONTEXT.md` only where a current effort list or example would otherwise be misleading. Historical PRDs/plans remain historical.

Required content:

- Ultra selects Codex's Ultra mode through its existing effort configuration and may increase usage. Distinguish the Models page's automatic-delegation description from the subagent guide's local-CLI rule: current local Codex delegates after a direct request or applicable project/skill instruction. Do not promise proactive delegation merely because Ralph selected Ultra. Ralph does not require or count child agents.
- Dated 0.154.0 catalog table from the PRD, linked official docs, and a clear statement that the table is informational, not an account access guarantee.
- `none`/`minimal` remain valid Ralph Codex tokens for compatible models but are absent from the listed modern-model snapshot. Codex checks actual model/client/account compatibility.
- Unchanged defaults, shared stage settings, source precedence, inherited-config behavior, generic-variable rejection, and no fallback.
- Newer clients may be needed for custom/stale images; distinguish the verified version from a historical minimum. Keep per-stage update behavior unchanged.

Examples to include:

```powershell
ralph-afk --agent codex --model gpt-5.6-sol --effort ultra --print-config
ralph-afk --agent codex --model gpt-5.6-sol --effort ultra "docs/plan.md" 3
$env:RALPH_CODEX_EFFORT = "ultra"
ralph-ghafk --agent codex --print-config
Remove-Item Env:RALPH_CODEX_EFFORT
```

### Verification

Run focused cases during development:

```text
pnpm --filter @daonhan/ralph-core exec vitest run src/__tests__/agents.test.ts src/__tests__/cli-help.test.ts src/__tests__/run-bin.test.ts src/__tests__/loop.test.ts
```

At the final candidate head, run the full gate and CI's existing offline checks:

```text
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm test
node scripts/smoke-render.mjs
node scripts/smoke-templates.mjs
node scripts/smoke-spill-size.mjs
node scripts/smoke-spill-large.mjs
```

The planning baseline's sole core failure is the pre-existing Windows CRLF assertion in `template-contract.test.ts:58` (380 passed / 1 failed). Record it if reproduced; do not weaken or skip it. A clean LF Linux checkout/CI at the final head must pass the entire gate before completion. If another failure appears, investigate it independently.

After building, use the local bins (not an older globally installed Ralph) to check both valid and invalid `--print-config` output. For the actual smoke, save this disposable driver as `.ralph-tmp/ultra-smoke.mjs` and run `node .ralph-tmp/ultra-smoke.mjs` from the candidate repository root. It selects an already installed image by immutable ID and disables the update/cache mount for this smoke only, so the captured client version is the one that runs. Normal Ralph update behavior remains covered by existing tests and is unchanged.

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  }).trim();
const imageRef =
  process.env.RALPH_IMAGE ?? "docker.io/daonhan/ralph-sandbox:latest";
const imageId = docker("image", "inspect", imageRef, "--format", "{{.Id}}");
const version = docker(
  "run",
  "--rm",
  "--entrypoint",
  "codex",
  imageId,
  "--version"
);
const catalog = JSON.parse(
  docker(
    "run",
    "--rm",
    "--entrypoint",
    "codex",
    imageId,
    "debug",
    "models",
    "--bundled"
  )
);
const model = "gpt-5.6-sol";
assert(
  catalog.models
    .find((m) => m.slug === model)
    ?.supported_reasoning_levels.some((level) => level.effort === "ultra"),
  "image catalog does not advertise Sol Ultra"
);

process.env.RALPH_IMAGE = imageId;
process.env.RALPH_CODEX_UPDATE = "0";
process.env.RALPH_DOCKER_SOCK = "0";
const { runStage } = await import(
  pathToFileURL(resolve("packages/core/dist/runner.js")).href
);
const { STAGES } = await import(
  pathToFileURL(resolve("packages/core/dist/stages.js")).href
);
const scratchWorkspace = mkdtempSync(join(tmpdir(), "ralph-ultra-smoke-"));
execFileSync("git", ["init", "--quiet", scratchWorkspace], {
  timeout: 10_000,
  windowsHide: true,
});
const logPath = join(scratchWorkspace, "ultra.ndjson");
const runId = `ultra-smoke-${randomUUID()}`;
const name = `ralph-${runId}`;
console.log(
  JSON.stringify({ imageId, version, model, effort: "ultra", logPath })
);
try {
  const result = await runStage(
    STAGES.implementer,
    "Reply with exactly RALPH_ULTRA_SMOKE_OK. Do not change files, run tools, commit, or delegate work.",
    scratchWorkspace,
    1,
    undefined,
    logPath,
    {
      agent: "codex",
      codexUserConfig: false,
      tuning: {
        model: { value: model, source: "--model" },
        effort: { value: "ultra", source: "--effort" },
      },
      signal: AbortSignal.timeout(120_000),
      container: { name, runId },
    }
  );
  assert.equal(result.text.trim(), "RALPH_ULTRA_SMOKE_OK");
  assert(!result.meta.isError && !result.meta.graceTimerFired);
  const events = readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  assert(events.some((event) => event.type === "turn.completed"));
  console.log(JSON.stringify({ text: result.text, meta: result.meta }));
} finally {
  const remaining = docker(
    "ps",
    "-a",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Names}}"
  );
  if (remaining) {
    docker("rm", "-f", name);
    throw new Error(`Smoke required forced container cleanup: ${name}`);
  }
}
```

The driver is evidence, not a committed new feature. Keep the scratch logs and driver with the worker's evidence, along with head SHA and the command exit status. Pair this live result with the exact argv unit test for U4; do not claim the catalog probe alone verifies account access. Completion must include the marker, `turn.completed`, no agent error, no grace-timer kill and no leftover named container. This smoke avoids the GitHub issue queue and feature workspace. It is one stage invocation without retries; unavailable authentication/model access is a blocker, not grounds to substitute another effort. It intentionally does not test delegation decisions. A daemon failure that prevents cleanup must be reported with the exact container name for reconciliation.

### Completion criteria

- [ ] U1–U9 have evidence, with exact command and head SHA for verification.
- [ ] No extra provider, default, schema, image, scheduler, or plugin behavior entered the diff.
- [ ] Independent code and security review required by the worker contract are complete; product repairs go through Ralph.
- [ ] Product docs match behavior and include the limitations above.
- [ ] The one feature PR is independently revertible; use a `feat(core)` commit and existing release automation.

## Issue-ready handoff for the separate worker

**Title:** `feat(core): support Codex Ultra effort and document model compatibility`

**Marker:** `slice-cycle:id=codex-ultra-effort`

**Body contract:** Implement Phase 1 of this plan and U1–U9 of the linked PRD. The baseline already implements model/effort flags and env precedence (#161/#162). Add only explicit/provider-env Codex Ultra support and its tests/docs. Preserve Sol/high, the shared five-level generic setting, per-run tuning, inherited config delegation, and Codex-owned compatibility errors. Record all validation evidence, including the scratch Ultra smoke. Follow the plan's out-of-scope boundaries and rollback. No prerequisite issue. One ready issue is sufficient; do not split docs away from the behavior they explain.

The separate task should:

1. Read the packaged `slice-cycle-worker` skill and run its `scripts/describe.mjs`; reconcile plugin/contract versions, the actual default branch, these artifacts, open/closed marker matches, existing Ralph activity, and worker ownership before any mutation.
2. Reuse these reviewed artifacts, including this task's planning commit. If they are not yet on the default branch, explicitly carry only that planning commit onto the worker's branch/worktree before implementation. Do not silently start from a default branch that lacks the requirements, and do not duplicate/reselect the slice.
3. Create/reconcile one issue using the marker, preserving existing queue labels. Reconcile the numeric slice number from the execution task's planning convention; the stable slice ID is already fixed here. No worker ordinal or invented runtime number is reserved by this planning-only task.
4. Use contract v1's ignored worker checkpoint and exact `ready-for-agent` queue isolation. Plugin 0.8.0 budgets from the number of ready issues plus one spare: one issue means two iterations. Do not import the personal ralph-slice-cycle skill's phase-count manifest or budget rules.
5. Run the companion's `ralph status`, `limits check`, `ralph codex-check`, then `ralph launch --repo <worker-repo> --issues <verified-issue-number> --agent codex` after its preflight. `<worker-repo>` and the issue number are resolved by that task, not guessed here. This launcher version does not expose `--effort`; BUILD can use its existing settings while the candidate's scratch smoke tests Ultra. No plugin changes are required.
6. Launch BUILD and perform review/push/PR only under that task's explicit authority. Missing merge authority ends at `pr-ready`; this planning request does not grant merge. Return the worker result capsule and evidence under its contract.

These are instructions for a future worker, not evidence that a task, issue, checkpoint, BUILD, PR or merge has already been created.

## Rollback

Revert the feature PR; remove explicit Ultra selections before running an older Ralph. There is no schema/data migration, and no host config or plugin-cache edit to undo.
