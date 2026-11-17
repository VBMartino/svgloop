# Releasing (maintainers)

## One-time setup

1. Create the repository `VBMartino/svgloop` on GitHub and push the `main` branch. If you use a different repository name, update the URLs in `package.json` and `.github/workflows/cla.yml`.
2. Use your GitHub no-reply email for commits (`git config user.email`) if you don't want your personal email in the public history.
3. Create an empty branch named `cla-signatures` (the CLA bot stores signatures there) and don't protect it.
4. In **Settings → Code security**, turn on **Private vulnerability reporting** (`SECURITY.md` points to it).
5. Check `.github/workflows/cla.yml` for a newer version of `contributor-assistant/github-action`.

## Each release

1. Update `version` in `package.json` **and** `src/name.ts`, and add a `CHANGELOG.md` entry.
2. Run `bun install`, `bun test`, `bun run typecheck` and `bun run notices`. Commit the updated `THIRD_PARTY_NOTICES.md`.
3. Check what npm will publish with `npm pack --dry-run`. It should list only `dist/cli.js`, `dist/index.js`, the examples, `style.md`, the example config and the legal and readme files.
4. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`. The **Release** workflow builds binaries for Windows, Linux and macOS and attaches them to a GitHub release.
5. Publish to npm: `npm publish` (`prepublishOnly` runs the tests and the Node build first).
