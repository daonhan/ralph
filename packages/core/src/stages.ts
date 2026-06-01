export type Stage = {
  name: string;
  template: string;
  permissionMode?: string;
};

// All stages run inside the ephemeral ralph-sandbox container (--rm). Bash +
// edits must auto-approve for AFK to work non-interactively, so every stage
// uses bypassPermissions.
//
// Blast radius depends on the docker.sock mount (on by default — see
// resolveDockerSocketMount in runner.ts): with the socket mounted the agent
// has root-equivalent access to the host Docker daemon (effectively the whole
// host); with RALPH_DOCKER_SOCK=0 it is bounded to the bind-mounted workspace
// tree, which is git-recoverable. See SECURITY.md.
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
