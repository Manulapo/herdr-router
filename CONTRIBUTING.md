# Contributing

```sh
bun install
bun test
bun run typecheck
```

- Keep it dependency-free at runtime (Bun built-ins only).
- Add a test for behavior changes; `test/router.test.ts` shows how to inject fake LLM and fetch implementations, so tests never call a model or the network.
- A test that touches the real environment must unset `OPENROUTER_API_KEY` first.
- Before pushing, check that the **whole** suite passes, not just the last lines of output.
- Keep `routing.example.toml`, `docs/configuration.md` and `hroute help` in step with config changes.
- Do not commit `routing.toml`, `.env` or anything with credentials (both are in `.gitignore`).
