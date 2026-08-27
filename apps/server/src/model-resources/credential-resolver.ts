import type { CredentialMetadata } from "@pi-science/contracts";
import { CredentialStore, type CredentialRuntimeValue } from "./credential-store.js";

/** Single credential lookup boundary used by routing and runtime projection.
 * Provider and endpoint code should not inspect process.env directly. */
export class CredentialResolver {
  constructor(private readonly store: CredentialStore = new CredentialStore()) {}

  resolve(credentialRef: string | null | undefined): Promise<CredentialRuntimeValue | null> {
    return credentialRef ? this.store.getForRuntime(credentialRef) : Promise.resolve(null);
  }

  metadata(credentialRef: string | null | undefined): Promise<CredentialMetadata | null> {
    return credentialRef ? this.store.metadata(credentialRef) : Promise.resolve(null);
  }

  resolveSync(credentialRef: string | null | undefined): CredentialRuntimeValue | null {
    return credentialRef ? this.store.readSync(credentialRef) : null;
  }
}
