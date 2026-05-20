export type Stage = {
  name: string;
  template: string;
  permissionMode?: string;
};

// All stages run inside the ephemeral ralph-sandbox container (--rm,
// bind-mounted workspace only). Bash + edits must auto-approve for AFK to
// work non-interactively, so every stage uses bypassPermissions. Worst-case
// blast radius is the workspace tree, recoverable via git.
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
