#!/usr/bin/env node
import { runGhAfk } from "@daonhan/ralph-core";

runGhAfk(process.argv.slice(2)).catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
