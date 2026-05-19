# Install crew

Six checkpoints from clone to seeing the plugin recognise your repo. Each step has one runnable command and one expected confirmation line. If a checkpoint fails, the failure is local to that step — don't proceed.

1. **Install Claude Code.**

   ```bash
   claude --version
   ```

   Expected confirmation:

   ```text
   claude 1.2.3
   ```

   (Any line matching `^claude \d+\.\d+\.\d+`.)

2. **Clone the repo and install plugin dependencies.**

   ```bash
   git clone https://github.com/jackmcintyre/crew.git && cd crew && pnpm --dir plugins/crew install
   ```

   Expected confirmation:

   ```text
   Done
   ```

   (The final line of `pnpm install` matches `^(Done|Already up to date)`.)

3. **Load the plugin into Claude Code.**

   Run two commands from the repo root, inside Claude Code:

   3a. Register the repo as a plugin marketplace:

   ```text
   /plugin marketplace add .
   ```

   Expected confirmation:

   ```text
   Marketplace added: crew
   ```

   3b. Install the `crew` plugin from that marketplace:

   ```text
   /plugin install crew@crew
   ```

   Expected confirmation:

   ```text
   Plugin installed: crew@0.1.0
   ```

   (The exact version comes from `plugins/crew/.claude-plugin/plugin.json`; `<semver>` matches `^\d+\.\d+\.\d+(?:-[\w.]+)?$`.)

4. **Restart Claude Code.**

   ```text
   Quit and reopen Claude Code (no shell command).
   ```

   Expected confirmation:

   ```text
   /crew:status
   ```

   (After reopen, the `/crew:` slash-command namespace appears in tab-complete with at least `/crew:status` listed.)

5. **Copy the standards template into your target repo.**

   ```bash
   cp plugins/crew/docs/standards-example.md <target-repo>/docs/standards.md
   ```

   `<target-repo>` may be the same as the cloned `crew` repo (Jack's same-repo case) or a different repo (Maya's split-repo case) — no behavioural difference.

   Expected confirmation:

   ```text
   <target-repo>/docs/standards.md
   ```

   (`ls <target-repo>/docs/standards.md` returns the path — the file now exists.)

6. **Run `/<plugin>:status` and see the expected line.**

   ```text
   /crew:status
   ```

   (Run inside Claude Code, with `<target-repo>` loaded as the workspace.)

   Expected confirmation:

   ```text
   crew v0.1.0
   target repo: /Users/you/projects/your-repo
   adapter: bmad (ok)
   standards: ok — /Users/you/projects/your-repo/docs/standards.md
   cycle: none
   ```

   (First line matches `^crew v\d+\.\d+\.\d+(?:-[\w.]+)?$`; the `standards:` line starts with `standards: ok`.)

## Build artefacts

`plugins/crew/mcp-server/dist/` is **committed to git by design** (Story 1.9). `/plugin install` copies the working tree as-is and does not run a build step, so the compiled MCP server must already be present in the tree.

Contract:

- Any change to `plugins/crew/mcp-server/src/**` must be followed by `pnpm install --frozen-lockfile && pnpm build` from `plugins/crew/mcp-server/`, and the resulting `dist/` committed in the same change.
- CI fails any PR where the committed `dist/` drifts from a fresh `pnpm build` (see `.github/workflows/ci.yml` — the `Verify committed dist/ matches fresh build` step runs `git diff --exit-code mcp-server/dist`). The vitest suite `tests/dist-shipping.test.ts` mirrors that check locally and also imports `dist/index.js` and `dist/tools/register.js` as a sentinel against partial builds.
- Do NOT re-add `dist/` (or `**/dist/`) to any `.gitignore`. If a new workspace package needs its own `dist/` ignored, name it explicitly and leave a comment.
- Do NOT introduce a `prepare` / `postinstall` build hook to "fix" this. `/plugin install` won't run it. The committed-artefact path is the v1 contract.

> See Story 7.2 (Epic 7) for the full first-run walkthrough.
