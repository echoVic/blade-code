import axios from 'axios';
import { createHash, randomBytes } from 'crypto';
import { URLSearchParams } from 'url';
import type { BladeConfig } from '../config/types/index.js';

export class OAuthProvider {
  protected config: BladeConfig;
  protected clientId: string;
  protected clientSecret: string;
  protected redirectUri: string;
  protected tokenUrl: string;
  protected authorizeUrl: string;
  protected scopes: string[];

  constructor(config: BladeConfig, options: OAuthOptions) {
    this.config = config;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.tokenUrl = options.tokenUrl;
    this.authorizeUrl = options.authorizeUrl;
    this.scopes = options.scopes || [];
  }

  public async generateAuthorizationUrl(state?: string): Promise<string> {
    if (!state) {
      state = this.generateState();
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      state: state,
    });

    return `${this.authorizeUrl}?${params.toString()}`;
  }

  public async exchangeCodeForToken(code: string, state?: string): Promise<OAuthToken> {
    try {
      const response = await axios.post(
        this.tokenUrl,
        {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          grant_type: 'authorization_code',
          code: code,
          state: state,
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const tokenData = response.data;

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenType: tokenData.token_type,
        expiresIn: tokenData.expires_in,
        scope: tokenData.scope,
        issuedAt: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      console.error('令牌交换失败:', error);
      throw new Error('令牌交换失败');
    }
  }

  public async refreshAccessToken(refreshToken: string): Promise<OAuthToken> {
    try {
      const response = await axios.post(
        this.tokenUrl,
        {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const tokenData = response.data;

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshToken,
        tokenType: tokenData.token_type,
        expiresIn: tokenData.expires_in,
        scope: tokenData.scope,
        issuedAt: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      console.error('令牌刷新失败:', error);
      throw new Error('令牌刷新失败');
    }
  }

  protected generateState(): string {
    return randomBytes(32).toString('hex');
  }

  protected generateCodeVerifier(): string {
    return randomBytes(32).toString('hex');
  }

  protected generateCodeChallenge(verifier: string): string {
    return createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  public validateState(state: string, expectedState: string): boolean {
    return state === expectedState;
  }

  public isTokenExpired(token: OAuthToken): boolean {
    if (!token.expiresIn || !token.issuedAt) {
      return false;
    }

    const expirationTime = token.issuedAt + token.expiresIn;
    const currentTime = Math.floor(Date.now() / 1000);

    // 提前5分钟刷新令牌
    return currentTime >= expirationTime - 300;
  }

  public getAuthorizationHeader(token: OAuthToken): string {
    return `${token.tokenType} ${token.accessToken}`;
  }
}

export class GoogleOAuthProvider extends OAuthProvider {
  constructor(config: BladeConfig) {
    super(config, {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: 'http://localhost:3000/oauth/callback/google',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      scopes: [
        'openid',
        'profile',
        'email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
    });
  }

  public async getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    try {
      const response = await axios.get(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const userData = response.data;

      return {
        id: userData.id,
        email: userData.email,
        name: userData.name,
        given_name: userData.given_name,
        family_name: userData.family_name,
        picture: userData.picture,
        locale: userData.locale,
        verified_email: userData.verified_email,
      };
    } catch (error) {
      console.error('获取用户信息失败:', error);
      throw new Error('获取用户信息失败');
    }
  }
}

export class GitHubOAuthProvider extends OAuthProvider {
  constructor(config: BladeConfig) {
    super(config, {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      redirectUri: 'http://localhost:3000/oauth/callback/github',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      scopes: ['user', 'repo', 'gist'],
    });
  }

  public async getUserInfo(accessToken: string): Promise<GitHubUserInfo> {
    try {
      const response = await axios.get('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      const userData = response.data;

      return {
        id: userData.id,
        login: userData.login,
        name: userData.name,
        email: userData.email,
        avatar_url: userData.avatar_url,
        url: userData.html_url,
        company: userData.company,
        blog: userData.blog,
        location: userData.location,
        bio: userData.bio,
        public_repos: userData.public_repos,
        public_gists: userData.public_gists,
        followers: userData.followers,
        following: userData.following,
        created_at: userData.created_at,
        updated_at: userData.updated_at,
      };
    } catch (error) {
      console.error('获取用户信息失败:', error);
      throw new Error('获取用户信息失败');
    }
  }
}

// 类型定义
interface OAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenUrl: string;
  authorizeUrl: string;
  scopes: string[];
}

interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  scope?: string;
  issuedAt?: number;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
  verified_email: boolean;
}

interface GitHubUserInfo {
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
  url: string;
  company: string;
  blog: string;
  location: string;
  bio: string;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
}
