import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

it("the shared reviewer checks both provider convention files", () => {
  const review = readFileSync(
    new URL("../../templates/review.md", import.meta.url),
    "utf8"
  );
  expect(review).toContain("AGENTS.md");
  expect(review).toContain("CLAUDE.md");
  expect(review).not.toContain(
    "Style violations vs `CLAUDE.md` or project conventions"
  );
});
