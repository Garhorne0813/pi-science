import { z } from "zod";

export const citationSourceKindSchema = z.enum(["doi", "arxiv", "file", "web"]);
export type CitationSourceKind = z.infer<typeof citationSourceKindSchema>;

export const citationLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lines"), startLine: z.number().int().min(1), endLine: z.number().int().min(1) })
    .refine((locator) => locator.endLine >= locator.startLine, { message: "endLine must be greater than or equal to startLine" }),
  z.object({ kind: z.literal("chars"), start: z.number().int().min(0), end: z.number().int().min(0) }),
  z.object({ kind: z.literal("whole-source") }),
]);
export type CitationLocator = z.infer<typeof citationLocatorSchema>;

export const citationSourceStatusSchema = z.enum(["verified", "changed", "missing", "forbidden", "unavailable", "identifier-only"]);
export type CitationSourceStatus = z.infer<typeof citationSourceStatusSchema>;

export const citationSourceSchema = z.object({
  /** `${kind}:${identity}`: the registry key the answer text is resolved against. */
  id: z.string().min(1),
  kind: citationSourceKindSchema,
  identity: z.string().min(1),
  title: z.string().min(1),
  locator: citationLocatorSchema,
  excerpt: z.string().nullable(),
  capturedAt: z.string().nullable(),
  evidence: z.object({ tool: z.string().min(1), callId: z.string().min(1), turnId: z.string().nullable() }).nullable(),
  status: citationSourceStatusSchema,
  statusDetail: z.string().nullable(),
});
export type CitationSource = z.infer<typeof citationSourceSchema>;

export const citationSourcesResponseSchema = z.object({ sessionId: z.string().min(1), sources: z.array(citationSourceSchema) });
export type CitationSourcesResponse = z.infer<typeof citationSourcesResponseSchema>;
