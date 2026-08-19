import { z } from "zod";

const environmentSchema = z.object({
  PI_SCIENCE_HOST: z.string().default("127.0.0.1"),
  PI_SCIENCE_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  PI_SCIENCE_PYTHON_ORIGIN: z.url().default("http://127.0.0.1:8788"),
  PI_SCIENCE_CORS: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),
  PI_SCIENCE_MAX_BODY_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  PI_SCIENCE_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PI_SCIENCE_INTERNAL_TOKEN: z.string().optional(),
  PI_SCIENCE_MANAGE_SCIENTIFIC_RUNTIME: z.enum(["0", "1"]).default("0"),
  PI_SCIENCE_PYTHON_EXECUTABLE: z.string().optional(),
  PI_SCIENCE_MICROMAMBA_EXECUTABLE: z.string().optional(),
  PI_SCIENCE_PYTHON_CWD: z.string().optional(),
  PI_SCIENCE_SCIENTIFIC_IDLE_MS: z.coerce.number().int().nonnegative().default(5 * 60_000),
  PI_SCIENCE_SCIENTIFIC_STARTUP_MS: z.coerce.number().int().positive().default(30_000),
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
  PI_SCIENCE_NODE_EXECUTIONS: z.enum(["0", "1"]).default("1"),
  PI_SCIENCE_NODE_LITERATURE: z.enum(["0", "1"]).default("1"),
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
  manageScientificRuntime?: boolean;
  pythonExecutable?: string;
  micromambaExecutable?: string;
  pythonCwd?: string;
  scientificIdleMs?: number;
  scientificStartupMs?: number;
  nodeSessions: boolean;
  nodeSse: boolean;
  nodeFiles: boolean;
  nodePiManager: boolean;
  nodeJobs?: boolean;
  nodeArtifacts?: boolean;
  nodeSettings?: boolean;
  nodeCatalog?: boolean;
  nodeProject?: boolean;
  nodeLiterature?: boolean;
  nodeCompute?: boolean;
  nodeWorkspaces?: boolean;
  nodeExecutions?: boolean;
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
    manageScientificRuntime: parsed.PI_SCIENCE_MANAGE_SCIENTIFIC_RUNTIME === "1",
    pythonExecutable: parsed.PI_SCIENCE_PYTHON_EXECUTABLE,
    micromambaExecutable: parsed.PI_SCIENCE_MICROMAMBA_EXECUTABLE,
    pythonCwd: parsed.PI_SCIENCE_PYTHON_CWD,
    scientificIdleMs: parsed.PI_SCIENCE_SCIENTIFIC_IDLE_MS,
    scientificStartupMs: parsed.PI_SCIENCE_SCIENTIFIC_STARTUP_MS,
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
    nodeExecutions: parsed.PI_SCIENCE_NODE_EXECUTIONS === "1",
    nodeLiterature: parsed.PI_SCIENCE_NODE_LITERATURE === "1",
    logLevel: parsed.LOG_LEVEL,
  };
}
