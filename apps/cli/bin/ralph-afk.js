#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAfk } from "@daonhan/ralph-core";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
const cliVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;

runAfk(process.argv.slice(2), { cliVersion }).catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
