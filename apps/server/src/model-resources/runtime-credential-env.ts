/** Generate an opaque environment name for a single runtime projection. The
 * credential reference is hashed so provider-specific public names never leak
 * into the runtime contract. */
export function runtimeCredentialEnvName(credentialRef: string): string {
  let hash = 0x811c9dc5;
  for (const character of credentialRef) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return `PI_RUNTIME_CREDENTIAL_${(hash >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

export function injectRuntimeCredentialEnv(env: NodeJS.ProcessEnv, credentialRef: string, secret: string): string {
  const name = runtimeCredentialEnvName(credentialRef);
  env[name] = secret;
  return name;
}
