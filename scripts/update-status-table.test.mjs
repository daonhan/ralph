// Unit tests for the pure rendering core of update-status-table.mjs.
// Run via `pnpm test` (node --test). No git / GitHub access required.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderStatusTable,
  replaceBlock,
  START,
  END,
} from "./update-status-table.mjs";

// Fixture: three components, mixed release state (one fully released with a
// dated tag + URL, one released without a URL, one never released).
const manifest = {
  "packages/core": "0.2.0",
  "apps/cli": "0.1.0",
  "packages/core/templates": "0.1.1",
};

const tagInfo = {
  "ralph-core": {
    tag: "ralph-core-v0.2.0",
    date: "2026-05-20",
    url: "https://github.com/daonhan/ralph/releases/tag/ralph-core-v0.2.0",
  },
  "ralph-sandbox": {
    tag: "ralph-sandbox-v0.1.1",
    date: "2026-04-02",
    // no url -> bare code-formatted tag
  },
  // "ralph" intentionally absent -> "—" date and tag
};

const EXPECTED = [
  "| Component | Artifact | Version | Released | Tag |",
  "| --- | --- | --- | --- | --- |",
  "| `ralph-core` | npm `@daonhan/ralph-core` | `0.2.0` | 2026-05-20 | [`ralph-core-v0.2.0`](https://github.com/daonhan/ralph/releases/tag/ralph-core-v0.2.0) |",
  "| `ralph` | npm `@daonhan/ralph` | `0.1.0` | — | — |",
  "| `ralph-sandbox` | Docker `daonhan/ralph-sandbox` | `0.1.1` | 2026-04-02 | `ralph-sandbox-v0.1.1` |",
].join("\n");

test("renderStatusTable snapshots the expected markdown block", () => {
  assert.equal(renderStatusTable(manifest, tagInfo), EXPECTED);
});

test("renderStatusTable is deterministic (stable row order, pure)", () => {
  assert.equal(
    renderStatusTable(manifest, tagInfo),
    renderStatusTable(manifest, tagInfo)
  );
});

test("renderStatusTable tolerates empty tagInfo (all dashes)", () => {
  const out = renderStatusTable(manifest, {});
  assert.match(
    out,
    /\| `ralph-core` \| npm `@daonhan\/ralph-core` \| `0.2.0` \| — \| — \|/
  );
});

test("renderStatusTable ignores tag info for a different manifest version", () => {
  const out = renderStatusTable(
    { ...manifest, "apps/cli": "0.6.1" },
    {
      ralph: {
        tag: "ralph-v0.5.1",
        date: "2026-05-22",
        url: "https://github.com/daonhan/ralph/releases/tag/ralph-v0.5.1",
      },
    }
  );

  assert.match(
    out,
    /\| `ralph` \| npm `@daonhan\/ralph` \| `0.6.1` \| — \| — \|/
  );
  assert.doesNotMatch(out, /ralph-v0\.5\.1/);
});

test("replaceBlock rewrites only between the markers", () => {
  const doc = `intro\n${START}\nstale\n${END}\noutro\n`;
  const out = replaceBlock(doc, "TABLE");
  assert.equal(out, `intro\n${START}\nTABLE\n${END}\noutro\n`);
  assert.ok(out.startsWith("intro\n"));
  assert.ok(out.endsWith("outro\n"));
});

test("replaceBlock throws when markers are missing", () => {
  assert.throws(
    () => replaceBlock("no markers here", "x"),
    /markers not found/
  );
});
