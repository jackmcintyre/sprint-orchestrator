# tiny-sprint

Self-contained fixture used by `scripts/e2e.ts`. Copied into a temp git
repo at the start of each e2e run; never executed in place.

Stories:

- `A` — happy path; ships with `src/hello.txt` so its AC passes immediately.
- `B` — backlog story depending on `A`; tests auto-promotion.
- `C` — designed-to-fail story; tests `markStoryFailed`.
