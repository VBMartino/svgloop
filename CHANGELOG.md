# Changelog

## 0.1.0 — first public release

- MCP server over stdio with the tools `make_graphic`, `graphic_status`, `stop_graphic`, `render_svg` and `export_graphic`. Long runs work as jobs, so clients never wait on a single long call.
- The loop: plan directions → draft SVG → sanitize and check → render (resvg) → vision review → revise, keeping each direction's best version → rank → export.
- The reviewer judges against the brief, on an anchored 0–10 scale. It reports what it sees, plus strengths, problems and fixes, and revisions are told what to keep.
- Canvas checks for blank, tiny and clipped drawings, including drawings on a solid or rounded background tile.
- Export: SVG, PNG at 16–512 px, a dark variant from the palette, and `.ico`.
- Configuration by environment variables (`SVGLOOP_*`) or `svgloop.config.json`, with `{env:NAME}` substitution.
- Command line with `--json` output; TypeScript library; standalone binaries.
