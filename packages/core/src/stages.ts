export type Stage = {
  name: string;
  template: string;
  permissionMode?: string;
};

// Every stage runs `claude --permission-mode bypassPermissions` so bash + edits
// auto-approve for non-interactive AFK. Blast radius is bounded by the runner
// (see resolveRunner in runner.ts): the default `sandbox` runner confines writes
// to the workspace via the native OS sandbox; `RALPH_RUNNER=host` runs unsandboxed
// (git-recoverable workspace only). See the spec under docs/superpowers/specs/.
export const STAGES = {
  implementer: {
    name: "implementer",
    template: "afk.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  ghafkImplementer: {
    name: "ghafk-implementer",
    template: "ghafk.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  reviewer: {
    name: "reviewer",
    template: "review.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
};
