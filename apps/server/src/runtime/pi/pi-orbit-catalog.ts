import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PiManager } from "./pi-manager.js";
import type { PiProcessOptions } from "./pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "./pi-runtime-launch.js";
import { configRoot } from "../../storage/persistence.js";

export type PiOrbitCatalogModel = {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
};

export type PiOrbitCatalogProvider = {
  id: string;
  name: string;
  baseUrl: string | null;
  auth: { apiKey: boolean; oauth: boolean; subscription: boolean; configured: boolean };
  models: PiOrbitCatalogModel[];
};

export type PiOrbitCatalog = { schemaVersion: 1; providers: PiOrbitCatalogProvider[] };

export class PiOrbitCatalogError extends Error {
  readonly code: "runtime_catalog_unavailable" | "runtime_catalog_incompatible";

  constructor(code: PiOrbitCatalogError["code"], message: string) {
    super(message);
    this.name = "PiOrbitCatalogError";
    this.code = code;
  }
}

export class PiOrbitCatalogService {
  private pending: Promise<PiOrbitCatalog> | undefined;

  constructor(
    private readonly manager: Pick<PiManager, "getCatalog">,
    private readonly optionsFactory: () => PiProcessOptions | null = defaultCatalogOptions,
  ) {}

  async getCatalog(): Promise<PiOrbitCatalog> {
    if (this.pending) return this.pending;
    const pending = this.load();
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  private async load(): Promise<PiOrbitCatalog> {
    const options = this.optionsFactory();
    if (!options) throw new PiOrbitCatalogError("runtime_catalog_unavailable", "Pi Orbit runtime is not installed or configured");
    try { return parseCatalog(await this.manager.getCatalog(options)); }
    catch (error) {
      if (error instanceof PiOrbitCatalogError) throw error;
      throw new PiOrbitCatalogError("runtime_catalog_unavailable", error instanceof Error ? error.message : String(error));
    }
  }
}

function defaultCatalogOptions(): PiProcessOptions | null {
  const cwd = join(resolve(configRoot()), "orbit-host");
  mkdirSync(cwd, { recursive: true });
  return buildPiProcessOptions(cwd, loadDefaultPiConfig(), undefined, {}, join(cwd, "sessions"));
}

function parseCatalog(value: unknown): PiOrbitCatalog {
  if (!value || typeof value !== "object") throw new PiOrbitCatalogError("runtime_catalog_incompatible", "Pi Orbit catalog response is not an object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.providers)) throw new PiOrbitCatalogError("runtime_catalog_incompatible", "Pi Orbit catalog schema is not supported");
  const providers = raw.providers.map(parseProvider);
  return { schemaVersion: 1, providers };
}

function parseProvider(value: unknown): PiOrbitCatalogProvider {
  if (!value || typeof value !== "object") throw new PiOrbitCatalogError("runtime_catalog_incompatible", "Pi Orbit catalog contains an invalid provider");
  const raw = value as Record<string, unknown>;
  const auth = raw.auth && typeof raw.auth === "object" ? raw.auth as Record<string, unknown> : null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || !auth || !Array.isArray(raw.models)) throw new PiOrbitCatalogError("runtime_catalog_incompatible", "Pi Orbit catalog provider is missing required fields");
  return {
    id: raw.id,
    name: raw.name,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : null,
    auth: { apiKey: rawBoolean(auth.apiKey), oauth: rawBoolean(auth.oauth), subscription: rawBoolean(auth.subscription), configured: rawBoolean(auth.configured) },
    models: raw.models.map(parseModel),
  };
}

function parseModel(value: unknown): PiOrbitCatalogModel {
  if (!value || typeof value !== "object") throw new PiOrbitCatalogError("runtime_catalog_incompatible", "Pi Orbit catalog contains an invalid model");
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.api !== "string" || typeof raw.reasoning !== "boolean" || !Array.isArray(raw.input)) throw new PiOrbitCatalogError("runtime_catalog_incompatible", "Pi Orbit catalog model is missing required fields");
  const contextWindow = positiveNumber(raw.contextWindow);
  const maxTokens = positiveNumber(raw.maxTokens);
  return { id: raw.id, name: raw.name, api: raw.api, reasoning: raw.reasoning, input: raw.input.map(String), contextWindow, maxTokens };
}

function rawBoolean(value: unknown): boolean { return value === true; }
function positiveNumber(value: unknown): number { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : 0; }
