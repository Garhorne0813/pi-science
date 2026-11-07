import { z } from "zod";

export const scientificRuntimeHealthSchema = z.object({
  status: z.literal("ok"),
  active_agent_workers: z.number().int().nonnegative(),
  active_kernels: z.number().int().nonnegative(),
});

export const gatewayHealthSchema = scientificRuntimeHealthSchema.extend({
  service: z.literal("pi-science-server"),
  control_plane: z.literal("node"),
});

export type GatewayHealth = z.infer<typeof gatewayHealthSchema>;
