import { z } from "zod";
import {
  assertGrantable,
  changeNetworkGrant,
  domainMatches,
  networkDomain,
  networkGrantProfile,
  networkGrantTargetKey,
  privateNetworkTarget,
  readNetworkGrants,
} from "../../sandbox/network-grants.js";
import { profileConfiguration } from "../../sandbox/profiles.js";
import type { InteractionBridge } from "./interaction-bridge.js";

/** Host-only approval invoked by the actual network request, never by the model. */
export async function requestNetworkAccess(
  bridge: InteractionBridge,
  params: { domain: string; profile?: "analysis" | "mcp"; reason?: string },
  signal?: AbortSignal,
) {
  const { domain, profile, reason } = z
    .object({
      domain: networkDomain,
      profile: networkGrantProfile.default("analysis"),
      reason: z.string().max(2000).optional(),
    })
    .strict()
    .parse(params);
  const target = privateNetworkTarget(domain);
  const access = target
    ? `HTTP and a TCP tunnel on port ${target.port} after TLS ClientHello inspection (the TLS handshake is not verified)`
    : "a TCP tunnel on port 443 after TLS ClientHello inspection (the TLS handshake is not verified)";
  const result = (status: string, message: string) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ status, message }) }],
    details: { status, domain, profile },
  });
  const check = async () => {
    await assertGrantable(profile, domain);
    const before = await readNetworkGrants();
    const decision = before.rules.some(
      (rule) =>
        rule.profile === profile && rule.decision === "deny" && domainMatches(domain, rule.domain),
    )
      ? "deny"
      : before.rules.find((rule) => rule.profile === profile && rule.domain === domain)?.decision;
    if (decision === "deny")
      return {
        before,
        settled: result(
          "denied",
          "A standing denial blocks this domain. The user can change it in Network settings.",
        ),
      };
    const config = await profileConfiguration();
    if (
      decision === "allow" ||
      config.profiles[profile]?.allowedDomains.some(
        (pattern) =>
          (!target || pattern.includes(":") || target.port === 443) &&
          domainMatches(domain, pattern),
      )
    )
      return {
        before,
        settled: result("already_allowed", `This destination is already allowed over ${access}.`),
      };
    return { before, settled: undefined };
  };
  const initial = await check();
  if (initial.settled) return initial.settled;
  // Keep the grant commit inside admission; waiting workers read fresh state.
  return bridge.withPermission(
    JSON.stringify(["network", profile, domain]),
    async () => {
      const { before, settled } = await check();
      if (settled) return settled;
      const answer = await bridge.request(`Network access: ${domain}`, "", signal, {
        method: "select",
        kind: "permission",
        message: `${reason ? `${reason}\n\n` : ""}Allow ${domain} over ${access} for ${profile} across all projects? This persists until revoked in Settings → Network.`,
        options: [
          { label: "Always allow", value: "allow" },
          { label: "Deny this request", value: "deny_once" },
          { label: "Never allow", value: "deny" },
        ],
      });
      signal?.throwIfAborted();
      if (answer !== "allow" && answer !== "deny")
        return result("denied", "Network access was not granted.");
      await changeNetworkGrant(
        { domain, profile, decision: answer },
        "approval",
        { targetRevision: before.targetRevisions[networkGrantTargetKey(profile, domain)] ?? 0 },
        reason,
      );
      return result(
        answer === "allow" ? "granted" : "denied",
        answer === "allow"
          ? "Access granted. The pending connection can continue."
          : "A standing denial was saved.",
      );
    },
    signal,
  );
}
