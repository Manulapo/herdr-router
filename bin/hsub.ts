#!/usr/bin/env bun
import { main } from "../src/cli.ts";

main(["sub", ...process.argv.slice(2)])
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`hsub: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
