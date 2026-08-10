import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface OAuthConfig {
  enabled?: boolean;
  clientId?: string;
  scopes?: string[];
  callbackPort?: number;
}

export type McpOAuthStatus =
  | 'disabled'
  | 'unavailable'
  | 'unauthenticated'
  | 'authorizing'
  | 'authenticated'
  | 'error';

export interface McpOAuthCredential {
  serverUrl: string;
  clientId?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  discoveryState?: OAuthDiscoveryState;
  updatedAt: string;
}

export interface McpOAuthCredentialStore {
  version: 1;
  credentials: Record<string, McpOAuthCredential>;
}

export interface McpOAuthLoginHandle {
  flowId: string;
  authorizationUrl: string;
  callbackUrl: string;
  completion: Promise<void>;
}

export interface McpOAuthProvider extends OAuthClientProvider {
  getStatus(): Promise<McpOAuthStatus>;
  hasUsableCredentials(): Promise<boolean>;
  beginAuthorization(): Promise<McpOAuthLoginHandle>;
  logout(): Promise<void>;
}
