#!/usr/bin/env node
// Guard against a half-completed release: flag any component whose newest
// release tag in git is ahead of the version actually published to its
// registry (npm / Docker Hub). This is the regression guard for the
// 0.6.3 episode, where git/GitHub held the tags but npm and the sandbox
// image lagged behind because the publish workflows never fired.
//
// The comparison core, `findLaggingComponents(state)`, is a pure function
// (per-component { tag, published } in -> list of lagging components out, no
// I/O) so it is unit-testable without git / npm / registry access. The outer
// shell (`main`) injects the live lookups and only runs when invoked directly.
//
// Usage:
//   node scripts/registries-not-behind-git.mjs   # exit 1 if any registry lags

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Source of truth for what to compare. `tagPrefix` matches the release-tag
// schema (`<component>-vX.Y.Z`); `registry`/`artifact` drive the live lookup.
export const COMPONENTS = [
  {
    component: "ralph-core",
    tagPrefix: "ralph-core-v",
    registry: "npm",
    artifact: "@daonhan/ralph-core",
  },
  {
    component: "ralph",
    tagPrefix: "ralph-v",
    registry: "npm",
    artifact: "@daonhan/ralph",
  },
  {
    component: "ralph-sandbox",
    tagPrefix: "ralph-sandbox-v",
    registry: "image",
    artifact: "daonhan/ralph-sandbox",
  },
];

/**
 * Extract [major, minor, patch] from a version or tag string. Tolerates a
 * `v`/tag prefix and any pre-release/build suffix. Returns null if no X.Y.Z
 * triple is present.
 *
 * @param {string|null|undefined} v
 * @returns {[number, number, number] | null}
 */
export function parseVersion(v) {
  if (!v) return null;
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Compare two version/tag strings. Returns -1 if a < b, 0 if equal, 1 if
 * a > b. Unparseable versions sort lowest (an unparseable/missing published
 * version is therefore "behind" any real tag). Usable as an Array#sort
 * comparator.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Pure comparison core. Given a per-component state map of the newest release
 * tag and the currently-published registry version, return the components
 * whose registry is *behind* the tag (git asserts a release the registry has
 * not served). A registry at or ahead of the tag is never flagged; a component
 * with no release tag cannot lag and is skipped.
 *
 * @param {Record<string, {tag?: string|null, published?: string|null}>} state
 * @returns {Array<{component: string, tag: string, published: string|null}>}
 */
export function findLaggingComponents(state) {
  const lagging = [];
  for (const c of COMPONENTS) {
    const s = (state && state[c.component]) || {};
    if (!s.tag) continue; // nothing released for this component -> can't lag
    if (compareVersions(s.tag, s.published) > 0) {
      lagging.push({
        component: c.component,
        tag: s.tag,
        published: s.published ?? null,
      });
    }
  }
  return lagging;
}

// ---- side-effectful lookups below; only used when run as a script ----

function git(args) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function latestTag(prefix) {
  try {
    const out = git(["tag", "--list", `${prefix}*`, "--sort=-v:refname"]);
    return out.split("\n").filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

function npmVersion(pkg) {
  return execFileSync("npm", ["view", pkg, "version"], {
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

async function imageVersion(repo) {
  const res = await fetch(
    `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`
  );
  if (!res.ok) throw new Error(`Docker Hub ${res.status}`);
  const body = await res.json();
  const versions = (body.results || [])
    .map((t) => t.name)
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
    .sort(compareVersions);
  return versions.length ? versions[versions.length - 1] : null;
}

async function collectState() {
  const state = {};
  const skipped = [];
  for (const c of COMPONENTS) {
    const tag = latestTag(c.tagPrefix);
    if (!tag) continue; // no release yet
    try {
      const published =
        c.registry === "npm"
          ? npmVersion(c.artifact)
          : await imageVersion(c.artifact);
      state[c.component] = { tag, published };
    } catch {
      // Couldn't determine the published version (e.g. transient registry
      // outage) — skip rather than raise a false "behind" alarm.
      skipped.push(c.component);
    }
  }
  return { state, skipped };
}

async function main() {
  const { state, skipped } = await collectState();
  const lagging = findLaggingComponents(state);
  if (skipped.length) {
    console.warn(
      `warning: could not determine published version for: ${skipped.join(", ")} (skipped)`
    );
  }
  if (lagging.length === 0) {
    console.log("registries are in sync with git tags");
    return;
  }
  for (const l of lagging) {
    console.error(
      `BEHIND: ${l.component} tag ${l.tag} > published ${l.published ?? "(none)"}`
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
