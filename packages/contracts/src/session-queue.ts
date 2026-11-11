import { z } from "zod";

/** A follow-up the user queued behind the running turn. `id` is the UUID the
 *  dispatcher reuses as the prompt's client_message_id, so the existing prompt
 *  ledger makes redelivery idempotent. */
export const queuedMessageStatusSchema = z.enum([
  "queued",
  "dispatching",
  "dispatched",
  "failed",
  "cancelled",
]);
export type QueuedMessageStatus = z.infer<typeof queuedMessageStatusSchema>;
export const queuedMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: queuedMessageStatusSchema,
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  error_code: z.string().optional(),
  delivered_message_id: z.string().optional(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

/** Authoritative per-session follow-up queue. `paused` records a manual pause;
 *  a stop no longer pauses the queue, and rows left by that old behaviour carry
 *  `paused_reason: "stop"`, which readers treat as unpaused and migrate. */
export const sessionQueueSchema = z.object({
  session_id: z.string().min(1),
  paused: z.boolean(),
  paused_reason: z.enum(["stop"]).optional(),
  entries: z.array(queuedMessageSchema),
  updated_at: z.string().min(1),
});
export type SessionQueue = z.infer<typeof sessionQueueSchema>;

/** A steer is delivered to the running turn, so it has a receipt, not a queue
 *  entry. `accepted` means the worker took it; consumption by the model is not
 *  observable and is never claimed. */
export const steerDeliveryStatusSchema = z.enum(["accepted", "rejected", "indeterminate"]);
export type SteerDeliveryStatus = z.infer<typeof steerDeliveryStatusSchema>;
export const steerResponseSchema = z.object({
  status: steerDeliveryStatusSchema,
  client_message_id: z.string().min(1),
  error_code: z.string().optional(),
});
export type SteerResponse = z.infer<typeof steerResponseSchema>;
