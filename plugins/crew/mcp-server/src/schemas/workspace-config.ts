import { z } from "zod";

/**
 * `.crew/config.yaml` schema.
 *
 * The top-level shape is validated here. The active adapter validates
 * its own `adapter_config` block via the adapter's own Zod schema —
 * see PlanningAdapter.adapterConfigSchema.
 */
export const PluginSettingsSchema = z
  .object({
    agreement_threshold: z.number().min(0).max(1).default(0.8),
    orchestration_interval_seconds: z.number().int().positive().default(120),
  })
  .default(() => ({ agreement_threshold: 0.8, orchestration_interval_seconds: 120 }));

export const WorkspaceConfigSchema = z.object({
  adapter: z.string().min(1),
  adapter_config: z.record(z.string(), z.unknown()).default({}),
  plugin: PluginSettingsSchema,
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type PluginSettings = z.infer<typeof PluginSettingsSchema>;
