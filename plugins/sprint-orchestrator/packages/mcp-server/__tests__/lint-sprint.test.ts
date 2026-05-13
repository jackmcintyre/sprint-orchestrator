import { describe, it, expect, afterEach } from "vitest";
import { makeTempProject } from "./fixtures.js";
import { lintSprint } from "../src/tools/lint-sprint.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(initial: object) {
  const tmp = await makeTempProject(initial);
  cleanups.push(tmp.cleanup);
  return tmp;
}

describe("lintSprint", () => {
  it("flags a state-mutator story with no integration AC", async () => {
    const { ctx } = await setup({
      sprint_id: "lint-fixture-mutator",
      stories: [
        {
          id: "M1",
          title: "Touches mark-story-complete with only structural AC",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [
              {
                type: "file_exists",
                path: "plugins/sprint-orchestrator/packages/mcp-server/src/tools/mark-story-complete.ts",
              },
              {
                type: "regex",
                cmd: "cat plugins/sprint-orchestrator/packages/mcp-server/src/tools/mark-story-complete.ts",
                pattern: "rework",
              },
            ],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx);
    const integrationIssue = report.issues.find(
      (i) => i.storyId === "M1" && /no integration AC/.test(i.message),
    );
    expect(integrationIssue).toBeDefined();
    expect(integrationIssue!.severity).toBe("error");
    expect(integrationIssue!.checkIndex).toBe(-1);
    expect(report.rendered).toMatch(/M1/);
    expect(report.rendered).toMatch(/integration AC/);
  });

  it("does not flag a state-mutator story when an integration AC is present", async () => {
    const { ctx } = await setup({
      sprint_id: "lint-fixture-mutator-ok",
      stories: [
        {
          id: "M2",
          title: "Touches commit-story-artefacts and runs e2e",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [
              {
                type: "file_exists",
                path: "plugins/sprint-orchestrator/packages/mcp-server/src/tools/commit-story-artefacts.ts",
              },
              {
                type: "shell",
                cmd: "pnpm --dir plugins/sprint-orchestrator e2e",
                expect_exit: 0,
              },
            ],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx);
    expect(report.issues.filter((i) => /integration AC/.test(i.message))).toHaveLength(0);
  });

  it("warns on shell checks that use vitest --grep", async () => {
    const { ctx } = await setup({
      sprint_id: "lint-fixture-grep",
      stories: [
        {
          id: "G1",
          title: "Bad shell pattern",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [{ type: "shell", cmd: "pnpm vitest --grep claim", expect_exit: 0 }],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx);
    const grepIssue = report.issues.find((i) => /vitest --grep/.test(i.message));
    expect(grepIssue).toBeDefined();
    expect(grepIssue!.severity).toBe("warn");
    expect(grepIssue!.checkIndex).toBe(0);
  });

  it("warns on trivial regex ACs targeting state-mutator files", async () => {
    const { ctx } = await setup({
      sprint_id: "lint-fixture-trivial-regex",
      stories: [
        {
          id: "R1",
          title: "Trivial regex on schema.ts",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [
              { type: "shell", cmd: "pnpm e2e", expect_exit: 0 },
              {
                type: "regex",
                cmd: "cat plugins/sprint-orchestrator/packages/mcp-server/src/state/schema.ts",
                pattern: "rework_count",
              },
            ],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx);
    const trivialIssue = report.issues.find((i) => /trivial literal grep/.test(i.message));
    expect(trivialIssue).toBeDefined();
    expect(trivialIssue!.severity).toBe("warn");
    expect(trivialIssue!.checkIndex).toBe(1);
  });

  it("does not warn on non-trivial regex (contains metacharacters)", async () => {
    const { ctx } = await setup({
      sprint_id: "lint-fixture-rich-regex",
      stories: [
        {
          id: "R2",
          title: "Non-trivial regex on schema.ts",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [
              { type: "shell", cmd: "pnpm e2e", expect_exit: 0 },
              {
                type: "regex",
                cmd: "cat plugins/sprint-orchestrator/packages/mcp-server/src/state/schema.ts",
                pattern: "rework_count\\s*:",
              },
            ],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx);
    expect(report.issues.filter((i) => /trivial literal grep/.test(i.message))).toHaveLength(0);
  });

  it("returns clean report for a non-mutator story with structural ACs", async () => {
    const { ctx } = await setup({
      sprint_id: "lint-fixture-clean",
      stories: [
        {
          id: "C1",
          title: "Just adds a doc",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [
              { type: "file_exists", path: "docs/new-page.md" },
              { type: "regex", cmd: "cat docs/new-page.md", pattern: "Overview" },
            ],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx);
    expect(report.issues).toHaveLength(0);
    expect(report.rendered).toMatch(/clean/);
  });

  it("flags shell cmd fields with unquoted YAML-special characters", async () => {
    const { ctx } = await setup({
      sprint_id: "lint-fixture-yaml-unsafe",
      stories: [
        {
          id: "Y1",
          title: "cmd has unquoted colon inside double-quoted grep arg",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [
              {
                type: "shell",
                cmd: 'pnpm e2e --grep "x: y"',
                expect_exit: 0,
              },
            ],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx);
    const yamlIssue = report.issues.find(
      (i) => i.storyId === "Y1" && /YAML-ambiguous/.test(i.message),
    );
    expect(yamlIssue).toBeDefined();
    expect(yamlIssue!.severity).toBe("error");
    expect(yamlIssue!.checkIndex).toBe(0);
    expect(yamlIssue!.message).toMatch(/stories\[Y1\]\.acceptance_criteria\.checks\[0\]\.cmd/);
  });

  it("does not flag a yaml-safe shell cmd", async () => {
    const { ctx } = await setup({
      sprint_id: "lint-fixture-yaml-safe",
      stories: [
        {
          id: "Y2",
          title: "cmd is plain and unambiguous",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [
              {
                type: "shell",
                cmd: "pnpm --dir plugins/sprint-orchestrator e2e",
                expect_exit: 0,
              },
            ],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx);
    expect(report.issues.filter((i) => /YAML-ambiguous/.test(i.message))).toHaveLength(0);
  });

  it("respects an explicit sprintStatusPath override", async () => {
    const { ctx } = await setup({
      sprint_id: "default-sprint",
      stories: [],
    });
    const other = await setup({
      sprint_id: "override-sprint",
      stories: [
        {
          id: "M3",
          title: "mutator no-e2e via override path",
          status: "ready",
          depends_on: [],
          acceptance_criteria: {
            checks: [
              {
                type: "file_exists",
                path: "plugins/sprint-orchestrator/packages/mcp-server/src/tools/get-ready-stories.ts",
              },
            ],
          },
          orchestrator: {},
        },
      ],
    });
    const report = await lintSprint(ctx, { sprintStatusPath: other.ctx.sprintStatusPath });
    expect(report.rendered).toMatch(/override-sprint/);
    expect(report.issues.find((i) => i.storyId === "M3")).toBeDefined();
  });
});
