#!/usr/bin/env node
import { runAfk } from "@daonhan/ralph-core";

runAfk(process.argv.slice(2)).catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
