import type { CreateCredentialRequest, CredentialMetadata } from "@pi-science/contracts";
import { CredentialStore } from "./credential-store.js";

export class CredentialService {
  constructor(readonly store: CredentialStore = new CredentialStore()) {}
  list(): Promise<CredentialMetadata[]> { return this.store.listMetadata(); }
  create(input: Partial<CreateCredentialRequest> & { id?: string }): Promise<CredentialMetadata> { return this.store.put(input); }
  update(id: string, input: Partial<CreateCredentialRequest>): Promise<CredentialMetadata> { return this.store.put({ ...input, id }); }
  remove(id: string): Promise<CredentialMetadata | null> { return this.store.remove(id); }
  validate(id: string): Promise<CredentialMetadata> { return this.store.validate(id); }
}
