import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function template(name: string): string {
  return readFileSync(
    new URL(`../../templates/${name}`, import.meta.url),
    "utf8"
  );
}

it("the shared reviewer checks both provider convention files", () => {
  const review = template("review.md");
  expect(review).toContain("AGENTS.md");
  expect(review).toContain("CLAUDE.md");
  expect(review).not.toContain(
    "Style violations vs `CLAUDE.md` or project conventions"
  );
});

describe("history injection contract", () => {
  it.each(["afk.md", "ghafk.md"])(
    "%s carries a <history> block wrapping {{ HISTORY }}",
    (name) => {
      const t = template(name);
      const open = t.indexOf("<history>");
      const tag = t.indexOf("{{ HISTORY }}");
      const close = t.indexOf("</history>");
      expect(open).toBeGreaterThanOrEqual(0);
      expect(tag).toBeGreaterThan(open);
      expect(close).toBeGreaterThan(tag);
    }
  );

  it.each(["prompt.md", "ghprompt.md"])(
    "%s tells the agent to read <history> and to end with Done/Blocked/Next",
    (name) => {
      const t = template(name);
      expect(t).toContain("<history>");
      expect(t).toContain("before task selection");
      expect(t).toContain("**Done**");
      expect(t).toContain("**Blocked**");
      expect(t).toContain("**Next**");
    }
  );

  it("the reviewer template carries no history block", () => {
    const review = template("review.md");
    expect(review).not.toContain("<history>");
    expect(review).not.toContain("{{ HISTORY }}");
  });
});

describe("shipped skills", () => {
  const skill = template("skills/ralph-tdd/SKILL.md");

  it("ralph-tdd names itself after its directory", () => {
    expect(skill).toMatch(/^---\nname: ralph-tdd\n/);
  });

  it("ralph-tdd has a description under Codex's 1024-character cap", () => {
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThan(1024);
  });

  it("ralph-tdd's frontmatter stays valid YAML", () => {
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
    // The loaders yaml.safe_load this block: an unquoted scalar carrying ": "
    // reads as a nested mapping and the whole skill fails to load.
    const quoted = /^"[^"]*"$/.test(description);
    expect(quoted || !description.includes(": ")).toBe(true);
  });

  it("ralph-tdd drops the interactive-run and sibling-skill text", () => {
    expect(skill).not.toContain("confirm them with the user");
    expect(skill).not.toContain("codebase-design");
    expect(skill).not.toContain("`code-review`");
  });

  it.each(["tests.md", "mocking.md", "LICENSE"])(
    "%s ships beside ralph-tdd's SKILL.md",
    (name) => {
      expect(
        existsSync(
          new URL(`../../templates/skills/ralph-tdd/${name}`, import.meta.url)
        )
      ).toBe(true);
    }
  );
});

describe("shipped skill usage", () => {
  it.each(["prompt.md", "ghprompt.md"])(
    "%s sends backend and library work through ralph-tdd",
    (name) => {
      const t = template(name);
      expect(t).toContain("`ralph-tdd`");
      expect(t).toContain("For frontend UI code, implement directly.");
    }
  );

  it("the reviewer template stays out of the implementation discipline", () => {
    const review = template("review.md");
    expect(review).not.toContain("ralph-tdd");
    expect(review).not.toContain("For frontend UI code, implement directly.");
  });
});
