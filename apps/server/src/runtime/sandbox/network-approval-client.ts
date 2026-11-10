import { request as httpRequest } from "node:http";
import type { NetworkApprovalEndpoint } from "./network-approval-channel.js";
import type { NetworkGrantProfile } from "./network-grant-state.js";

/** Called by the trusted launcher, outside the workload's network namespace. */
export function requestNetworkApproval(
  endpoint: NetworkApprovalEndpoint,
  domain: string,
  profile: NetworkGrantProfile,
  signal: AbortSignal,
  contextId?: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: endpoint.port,
        method: "POST",
        path: "/",
        signal,
        headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
        timeout: 120_000,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 4096) request.destroy();
        });
        response.on("end", () => {
          try {
            resolve(response.statusCode === 200 && JSON.parse(body).allowed === true);
          } catch {
            resolve(false);
          }
        });
        response.on("error", () => resolve(false));
        response.on("aborted", () => resolve(false));
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
    request.end(JSON.stringify({ domain, profile, ...(contextId ? { contextId } : {}) }));
  });
}
