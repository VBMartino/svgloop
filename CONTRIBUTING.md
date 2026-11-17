# Contributing to SVGLoop

Thanks for helping! Bug reports, model test results, prompts that draw better, and code are all welcome.

## Contributor License Agreement

Before a pull request can be merged, you need to sign the [CLA](CLA.md). On your first pull request a bot posts a comment explaining how: you reply with the sentence it gives. You only sign once.

## Reporting results from your models

SVGLoop's output depends heavily on the model. Reports of which models and servers work well, or badly, are very useful. Please include:

- the model and quantization, the server (llama.cpp, Ollama, LM Studio, …) and its version;
- your GPU or CPU and whether the model fit in VRAM;
- the brief, and the run folder's `result.json` plus a few PNGs if you can share them.

## Development

You need [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install
bun test                 # all tests run offline against a stand-in model server
bun run typecheck
bun run build:node       # dist/cli.js, what npm/npx runs
node dist/cli.js --help  # check the Node build
```

To try changes against a real model, start a server (see `scripts/start-llama.*`), then run:

```bash
bun src/cli.ts ping --config your.config.json
bun src/cli.ts make --brief "..." --config your.config.json
```

## Pull requests

- Keep each pull request focused on one change, and add or update tests in `test/`.
- Run `bun test` and `bun run typecheck` before pushing.
- For prompt changes (`src/prompts.ts`), include before/after results from a real model. Prompts behave differently across models, so say which you tried.
- User-visible names live in `src/name.ts`; don't hard-code the product name elsewhere.
- Security-sensitive code is `src/sanitize.ts`. Any change there needs a test showing what it removes or keeps.

## Code of conduct

Be kind and constructive. Harassment of any kind isn't tolerated.
