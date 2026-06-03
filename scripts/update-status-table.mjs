#!/usr/bin/env node
// Regenerates the status-table block in RELEASING.md from the release-please
// manifest plus per-component Git tag metadata.
//
// The rendering core, `renderStatusTable(manifest, tagInfo)`, is a pure function
// (manifest in, markdown out — no side effects) so it can be unit tested without
// touching git or GitHub. The outer shell (`main`) wires in the git/GH lookups and
// the file rewrite, and only runs when this file is invoked directly.
//
// Usage:
//   node scripts/update-status-table.mjs          # rewrite RELEASING.md in place
//   node scripts/update-status-table.mjs --check   # exit 1 if it would change

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const START = "<!-- status-table:start -->";
export const END = "<!-- status-table:end -->";

// Manifest path -> component metadata. The order here is the row order in the table.
export const COMPONENTS = [
  {
    path: "packages/core",
    component: "ralph-core",
    artifact: "npm `@daonhan/ralph-core`",
  },
  {
    path: "apps/cli",
    component: "ralph",
    artifact: "npm `@daonhan/ralph`",
  },
  {
    path: "packages/core/templates",
    component: "ralph-sandbox",
    artifact: "Docker `daonhan/ralph-sandbox`",
  },
];

export function expectedReleaseTag(component, version) {
  if (!version || version === "—") return undefined;
  return `${component}-v${version}`;
}

function tagInfoForManifestVersion(component, version, info) {
  const expectedTag = expectedReleaseTag(component, version);
  if (!expectedTag || !info || info.tag !== expectedTag) return {};
  return info;
}

/**
 * Pure renderer: given the parsed release-please manifest and a tag-info map
 * keyed by component name ({ tag, date, url }), return the markdown table that
 * lives between the status-table markers. No side effects.
 *
 * @param {Record<string, string>} manifest  e.g. { "packages/core": "0.1.1" }
 * @param {Record<string, {tag?: string, date?: string, url?: string}>} tagInfo
 * @returns {string}
 */
export function renderStatusTable(manifest, tagInfo) {
  const rows = COMPONENTS.map((c) => {
    const version = manifest[c.path] ?? "—";
    const info = tagInfoForManifestVersion(
      c.component,
      version,
      tagInfo && tagInfo[c.component]
    );
    const released = info.date ?? "—";
    const tagCell = info.tag
      ? info.url
        ? `[\`${info.tag}\`](${info.url})`
        : `\`${info.tag}\``
      : "—";
    return `| \`${c.component}\` | ${c.artifact} | \`${version}\` | ${released} | ${tagCell} |`;
  });
  return [
    "| Component | Artifact | Version | Released | Tag |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * Replace the content between the status-table markers with `table`, preserving
 * everything outside the markers (including the markers themselves). Pure.
 */
export function replaceBlock(doc, table) {
  const s = doc.indexOf(START);
  const e = doc.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(
      `status-table markers not found (expected ${START} … ${END})`
    );
  }
  return doc.slice(0, s + START.length) + "\n" + table + "\n" + doc.slice(e);
}

// ---- side-effectful shell below; only used when run as a script ----

function git(args) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function repoSlug() {
  try {
    const url = git(["config", "--get", "remote.origin.url"]);
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function collectTagInfo(manifest) {
  const slug = repoSlug();
  const tagInfo = {};
  for (const c of COMPONENTS) {
    const expectedTag = expectedReleaseTag(c.component, manifest[c.path]);
    if (!expectedTag) continue;
    let line = "";
    try {
      line = git([
        "for-each-ref",
        "--format=%(refname:short)\t%(creatordate:short)",
        `refs/tags/${expectedTag}`,
      ]).split("\n")[0];
    } catch {
      line = "";
    }
    if (!line) continue;
    const [tag, date] = line.split("\t");
    if (!tag) continue;
    tagInfo[c.component] = {
      tag,
      date: date || undefined,
      url: slug ? `https://github.com/${slug}/releases/tag/${tag}` : undefined,
    };
  }
  return tagInfo;
}

function main() {
  const check = process.argv.includes("--check");
  const manifest = JSON.parse(
    readFileSync(".release-please-manifest.json", "utf8")
  );
  const tagInfo = collectTagInfo(manifest);
  const doc = readFileSync("RELEASING.md", "utf8");
  const updated = replaceBlock(doc, renderStatusTable(manifest, tagInfo));
  if (updated === doc) {
    console.log("status table already up to date");
    return;
  }
  if (check) {
    console.error(
      "RELEASING.md status table is out of date (run without --check)"
    );
    process.exit(1);
  }
  writeFileSync("RELEASING.md", updated);
  console.log("RELEASING.md status table updated");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
