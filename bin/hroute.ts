#!/usr/bin/env bun
import { main } from "../src/cli.ts";

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`hroute: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
