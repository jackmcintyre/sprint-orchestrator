import { z } from "zod";

export const MarketplaceManifestSchema = z.object({
  name: z.string().min(1),
  owner: z.object({ name: z.string().min(1) }),
  plugins: z
    .array(
      z.object({
        name: z.string().min(1),
        source: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .min(1),
});

export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;
