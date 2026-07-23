import { z } from "zod";

const environmentSchema = z.object({
  PI_SCIENCE_HOST: z.string().default("127.0.0.1"),
  PI_SCIENCE_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  PI_SCIENCE_PYTHON_ORIGIN: z.url().default("http://127.0.0.1:8788"),
  PI_SCIENCE_CORS: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),
  PI_SCIENCE_MAX_BODY_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  PI_SCIENCE_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PI_SCIENCE_INTERNAL_TOKEN: z.string().optional(),
  PI_SCIENCE_NODE_SESSIONS: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_SSE: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_FILES: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_PI_MANAGER: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_JOBS: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_ARTIFACTS: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_SETTINGS: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_CATALOG: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_PROJECT: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_COMPUTE: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_WORKSPACES: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_RUNS: z.enum(["0", "1"]).default("1"),
  LOG_LEVEL: z.string().default("info"),
});

export interface ServerConfig {
  host: string;
  port: number;
  pythonOrigin: string;
  corsOrigins: string[];
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  internalToken?: string;
  nodeSessions: boolean;
  nodeSse: boolean;
  nodeFiles: boolean;
  nodePiManager: boolean;
  nodeJobs?: boolean;
  nodeArtifacts?: boolean;
  nodeSettings?: boolean;
  nodeCatalog?: boolean;
  nodeProject?: boolean;
  nodeCompute?: boolean;
  nodeWorkspaces?: boolean;
  nodeRuns?: boolean;
  logLevel: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    host: parsed.PI_SCIENCE_HOST,
    port: parsed.PI_SCIENCE_PORT,
    pythonOrigin: parsed.PI_SCIENCE_PYTHON_ORIGIN.replace(/\/$/, ""),
    corsOrigins: parsed.PI_SCIENCE_CORS.split(",").map((origin) => origin.trim()).filter(Boolean),
    maxBodyBytes: parsed.PI_SCIENCE_MAX_BODY_BYTES,
    upstreamTimeoutMs: parsed.PI_SCIENCE_UPSTREAM_TIMEOUT_MS,
    internalToken: parsed.PI_SCIENCE_INTERNAL_TOKEN,
    nodeSessions: parsed.PI_SCIENCE_NODE_SESSIONS === "1",
    nodeSse: parsed.PI_SCIENCE_NODE_SSE === "1",
    nodeFiles: parsed.PI_SCIENCE_NODE_FILES === "1",
    nodePiManager: parsed.PI_SCIENCE_NODE_PI_MANAGER === "1",
    nodeJobs: parsed.PI_SCIENCE_NODE_JOBS === "1",
    nodeArtifacts: parsed.PI_SCIENCE_NODE_ARTIFACTS === "1",
    nodeSettings: parsed.PI_SCIENCE_NODE_SETTINGS === "1",
    nodeCatalog: parsed.PI_SCIENCE_NODE_CATALOG === "1",
    nodeProject: parsed.PI_SCIENCE_NODE_PROJECT === "1",
    nodeCompute: parsed.PI_SCIENCE_NODE_COMPUTE === "1",
    nodeWorkspaces: parsed.PI_SCIENCE_NODE_WORKSPACES === "1",
    nodeRuns: parsed.PI_SCIENCE_NODE_RUNS === "1",
    logLevel: parsed.LOG_LEVEL,
  };
}
