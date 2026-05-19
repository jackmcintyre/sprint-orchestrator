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

   ```text
   /plugin install plugins/crew
   ```

   (Run from the repo root, inside Claude Code.)

   Expected confirmation:

   ```text
   Plugin installed: crew@0.1.0
   ```

   (Where `<semver>` matches `^\d+\.\d+\.\d+(?:-[\w.]+)?$`.)

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

> See Story 7.2 (Epic 7) for the full first-run walkthrough.
