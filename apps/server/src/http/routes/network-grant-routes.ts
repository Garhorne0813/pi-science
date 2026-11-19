import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  changeNetworkGrant,
  networkDomain,
  networkGrantProfile,
  networkRuleInput,
  readNetworkGrants,
  revokeNetworkGrant,
} from "../../runtime/sandbox/network-grants.js";
import {
  BUILTIN_DENIED_DOMAINS,
  DEFAULT_SCIENCE_DOMAINS,
  SCIENCE_NETWORK_DEFAULTS_VERSION,
  profileConfiguration,
} from "../../runtime/sandbox/profiles.js";

export function registerNetworkGrantRoutes(app: FastifyInstance) {
  app.get("/api/settings/network", async () => {
    const [state, config] = await Promise.all([readNetworkGrants(), profileConfiguration()]);
    return {
      ...state,
      defaultsVersion: SCIENCE_NETWORK_DEFAULTS_VERSION,
      profiles: Object.fromEntries(
        ["analysis", "mcp"].map((profile) => {
          const policy = config.profiles[profile as "analysis" | "mcp"];
          return [
            profile,
            {
              defaultDomains: DEFAULT_SCIENCE_DOMAINS[profile as "analysis" | "mcp"],
              allowedDomains: policy?.allowedDomains ?? [],
              deniedDomains: [...BUILTIN_DENIED_DOMAINS, ...(policy?.deniedDomains ?? [])],
            },
          ];
        }),
      ),
    };
  });
  app.post("/api/settings/network", async (request, reply) => {
    try {
      return await changeNetworkGrant(networkRuleInput.parse(request.body), "settings");
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : "Invalid network permission" });
    }
  });
  app.delete("/api/settings/network", async (request, reply) => {
    try {
      const value = z
        .object({ profile: networkGrantProfile, domain: networkDomain })
        .strict()
        .parse(request.body);
      return await revokeNetworkGrant(value.profile, value.domain);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : "Invalid network permission" });
    }
  });
}
