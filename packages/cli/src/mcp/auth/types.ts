/**
 * OAuth 相关类型定义
 */

/**
 * OAuth 令牌
 */
export interface OAuthToken {
  accessToken: string;
  tokenType: string;
  expiresAt?: number;
  refreshToken?: string;
  scope?: string;
}

/**
 * OAuth 配置
 */
export interface OAuthConfig {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  redirectUri?: string;
}

/**
 * OAuth 凭证（包含令牌和元数据）
 */
export interface OAuthCredentials {
  serverName: string;
  token: OAuthToken;
  clientId?: string;
  tokenUrl?: string;
  updatedAt: number;
}

/**
 * OAuth 令牌响应
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}
