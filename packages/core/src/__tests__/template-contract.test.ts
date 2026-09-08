import { readFileSync } from "node:fs";

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
