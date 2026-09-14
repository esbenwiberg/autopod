export type ConfigurationCredentialPurpose =
  | 'registry-read'
  | 'mcp-http'
  | 'mcp-env'
  | 'build-env'
  | 'deployment-env';
/** Public metadata only. Credential values never belong in configuration/snapshot responses. */
export interface ConfigurationCredential {
  id: string;
  name: string;
  purposes: ConfigurationCredentialPurpose[];
  origins: string[];
  revision: number;
  revoked: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ResolvedCredentialReference {
  secretId: string;
  createdAt: string;
  purposes: ConfigurationCredentialPurpose[];
  origins: string[];
}
