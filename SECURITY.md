# Security policy

SVGLoop renders SVG written by language models, so the sanitizer (`src/sanitize.ts`) and the renderer are its security boundary.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting instead: the **Security** tab of this repository, then **Report a vulnerability**. You should get a reply within a week.

Especially useful reports:

- SVG that gets past `cleanSvg` and runs script, loads an outside resource, or reads local files when rendered or opened;
- ways to make MCP tools write outside the configured output folder;
- crashes or hangs caused by crafted SVG.

## Supported versions

Security fixes go into the latest release.
