import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { STATE_FILE_RELATIVE, type ToolContext } from "../src/tools/context.js";

export async function makeTempProject(initialYaml: string | object): Promise<{
  ctx: ToolContext;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-orch-"));
  const sprintStatusPath = path.join(root, STATE_FILE_RELATIVE);
  await fs.mkdir(path.dirname(sprintStatusPath), { recursive: true });
  const yaml = typeof initialYaml === "string" ? initialYaml : YAML.stringify(initialYaml);
  await fs.writeFile(sprintStatusPath, yaml, "utf8");
  const ctx: ToolContext = {
    projectRoot: root,
    sprintStatusPath,
    configPath: path.join(root, ".sprint-orchestrator", "config.yaml"),
  };
  return {
    ctx,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export const baseSprint = {
  sprint_id: "test-sprint-1",
  stories: [
    {
      id: "S1",
      title: "First story",
      status: "ready",
      depends_on: [] as string[],
      acceptance_criteria: { checks: [] },
      orchestrator: {},
    },
    {
      id: "S2",
      title: "Depends on S1",
      status: "ready",
      depends_on: ["S1"],
      acceptance_criteria: { checks: [] },
      orchestrator: {},
    },
    {
      id: "S3",
      title: "Already done",
      status: "done",
      depends_on: [],
      acceptance_criteria: { checks: [] },
      orchestrator: { completed_at: "2026-05-12T08:00:00Z", summary: "ok" },
    },
  ],
};
