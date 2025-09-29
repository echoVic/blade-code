/**
 * 安全的 HTTP 客户端
 * 提供增强的安全特性
 */

import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from 'axios';
import crypto, { createHash, createHmac } from 'crypto';
import https from 'https';

export interface SecureHttpClientOptions {
  baseURL?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
  validateCertificates?: boolean;
  enforceTLS12?: boolean;
  allowedHosts?: string[];
  rateLimit?: {
    requests: number;
    period: number; // 毫秒
  };
}

export class SecureHttpClient {
  private client: AxiosInstance;
  private rateLimitMap = new Map<string, { count: number; resetTime: number }>();
  private options: Required<SecureHttpClientOptions>;

  constructor(options: SecureHttpClientOptions = {}) {
    this.options = {
      baseURL: options.baseURL || '',
      timeout: options.timeout || 30000,
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1000,
      validateCertificates: options.validateCertificates !== false,
      enforceTLS12: options.enforceTLS12 !== false,
      allowedHosts: options.allowedHosts || [],
      rateLimit: options.rateLimit || { requests: 100, period: 60000 },
    };

    this.client = this.createSecureClient();
  }

  /**
   * 创建安全的 Axios 客户端
   */
  private createSecureClient(): AxiosInstance {
    const agent = new https.Agent({
      // 强制 TLS 1.2+
      secureProtocol: this.options.enforceTLS12 ? 'TLSv1_2_method' : undefined,
      // 验证证书
      rejectUnauthorized: this.options.validateCertificates,
    });

    const client = axios.create({
      baseURL: this.options.baseURL,
      timeout: this.options.timeout,
      httpsAgent: agent,
    });

    // 请求拦截器 - 安全检查
    client.interceptors.request.use(
      (config) => {
        // 主机验证
        if (this.options.allowedHosts && this.options.allowedHosts.length > 0) {
          const url = new URL(config.url || '', config.baseURL);
          if (!this.options.allowedHosts.includes(url.hostname)) {
            throw new Error(`Host ${url.hostname} is not allowed`);
          }
        }

        // 速率限制
        if (this.options.rateLimit) {
          const now = Date.now();
          const host = config.url
            ? new URL(config.url, config.baseURL).hostname
            : 'default';
          const rateLimitInfo = this.rateLimitMap.get(host);

          if (rateLimitInfo) {
            if (now < rateLimitInfo.resetTime) {
              if (rateLimitInfo.count >= this.options.rateLimit.requests) {
                throw new Error(`Rate limit exceeded for host ${host}`);
              }
              rateLimitInfo.count++;
            } else {
              rateLimitInfo.count = 1;
              rateLimitInfo.resetTime = now + this.options.rateLimit.period;
            }
          } else {
            this.rateLimitMap.set(host, {
              count: 1,
              resetTime: now + this.options.rateLimit.period,
            });
          }
        }

        return config;
      },
      (error) => Promise.reject(error)
    );

    return client;
  }

  /**
   * GET 请求
   */
  async get<T = any>(
    url: string,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  /**
   * POST 请求
   */
  async post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'POST', url, data });
  }

  /**
   * PUT 请求
   */
  async put<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'PUT', url, data });
  }

  /**
   * DELETE 请求
   */
  async delete<T = any>(
    url: string,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'DELETE', url });
  }

  /**
   * 通用请求方法
   */
  async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let lastError: any;

    for (let attempt = 0; attempt <= this.options.retryAttempts; attempt++) {
      try {
        const response = await this.client.request<T>(config);
        return response;
      } catch (error) {
        lastError = error;

        // 如果不应该重试，则立即抛出错误
        if (!this.shouldRetry(error) || attempt === this.options.retryAttempts) {
          throw error;
        }

        // 等待重试延迟
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.retryDelay * Math.pow(2, attempt))
        );
      }
    }

    throw lastError;
  }

  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: any): boolean {
    // 只对某些错误码重试
    const retryableCodes = [
      'ECONNRESET',
      'ECONNABORTED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
    ];

    const retryableStatus = [408, 429, 500, 502, 503, 504];

    return (
      retryableCodes.includes(error.code) ||
      (error.response && retryableStatus.includes(error.response.status))
    );
  }
}

// 创建默认实例导出
export const secureHttpClient = new SecureHttpClient();
