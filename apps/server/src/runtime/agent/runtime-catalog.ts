export type RuntimeCatalogModel = {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  thinkingLevels?: string[];
  input: string[];
  contextWindow: number;
  maxTokens: number;
};

export type RuntimeCatalogProvider = {
  id: string;
  name: string;
  baseUrl: string | null;
  auth: { apiKey: boolean; oauth: boolean; subscription: boolean; configured: boolean };
  models: RuntimeCatalogModel[];
};

export type RuntimeCatalog = { schemaVersion: 1; providers: RuntimeCatalogProvider[] };

export interface RuntimeCatalogService { getCatalog(): Promise<RuntimeCatalog> }
