import type { DefaultGenerics, ExtendableGenerics, TokenRefreshResult, UserResponse, UsersResponse } from '../types';
import {
  type EndUserAuthApi,
  type EndUserAuthResponse,
  type EndUserClientApi,
  type EndUserSearchRequest,
  type EndUserTransport,
} from './contract';

function createNonce(length: number): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

export class LegacyEndUserAuthApi implements EndUserAuthApi {
  readonly mode = 'legacy' as const;

  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly transport: EndUserTransport,
  ) {}

  sendOtpToPhone(identifier: string, method: 'Sms' | 'Voice') {
    return this.transport.request<EndUserAuthResponse>('post', this.baseURL + '/auth/get_otp_new', {
      apikey: this.apiKey,
      identifier,
      language: 'Vi',
      method,
      otp_type: 'Login',
    });
  }

  sendOtpToEmail(identifier: string) {
    return this.transport.request<EndUserAuthResponse>('post', this.baseURL + '/auth/get_otp_new', {
      apikey: this.apiKey,
      identifier,
      language: 'Vi',
      method: 'Email',
      otp_type: 'Login',
    });
  }

  verifyOtp(identifier: string | undefined, method: 'Sms' | 'Voice' | 'Email' | undefined, otp: string) {
    return this.transport.request<EndUserAuthResponse>('post', this.baseURL + '/auth/otp_login', {
      identifier,
      method,
      apikey: this.apiKey,
      otp,
    });
  }

  loginWithGoogle(token: string) {
    return this.transport.request<EndUserAuthResponse>('post', this.baseURL + '/auth/google_login', {
      token,
      apikey: this.apiKey,
    });
  }

  async getWalletChallenge(address: string): Promise<unknown> {
    const response = await this.transport.request<{ challenge: string }>('post', this.baseURL + '/auth/get_challenge', {
      address,
      apikey: this.apiKey,
    });
    return JSON.parse(response.challenge);
  }

  verifyWalletSignature(address: string | undefined, signature: string) {
    return this.transport.request<EndUserAuthResponse>('post', this.baseURL + '/auth/verify_signature', {
      address,
      signature,
      nonce: createNonce(20),
      apikey: this.apiKey,
    });
  }
}

export class LegacyEndUserClientApi<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>
  implements EndUserClientApi<ErmisChatGenerics>
{
  readonly mode = 'legacy' as const;

  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly getProjectId: () => string | undefined,
    private readonly transport: EndUserTransport,
  ) {}

  async refreshToken(refreshToken: string): Promise<TokenRefreshResult> {
    const response = await this.transport.publicRequest<TokenRefreshResult>('post', this.baseURL + '/refresh_token', {
      refresh_token: refreshToken,
    });
    if (!response.token) throw new Error('Refresh token response did not include token');
    return response;
  }

  externalAuth(user: UserResponse<ErmisChatGenerics>, token: string | null) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    return this.transport.publicRequest<EndUserAuthResponse>(
      'get',
      this.baseURL + '/get_token/external_auth',
      undefined,
      {
        params: { apikey: this.apiKey, name: user.name, ...(user.avatar ? { avatar: user.avatar } : {}) },
        headers,
      },
    );
  }

  getSseUrl() {
    return this.baseURL + '/sse/subscribe';
  }

  queryUsers(pageSize: number, page: number) {
    return this.transport.request<UsersResponse<ErmisChatGenerics>>('get', this.baseURL + '/users', undefined, {
      params: { project_id: this.getProjectId(), page, page_size: pageSize },
    });
  }

  queryUser(userId: string) {
    return this.transport.request<UserResponse<ErmisChatGenerics>>(
      'get',
      `${this.baseURL}/users/${userId}`,
      undefined,
      {
        params: { project_id: this.getProjectId() },
      },
    );
  }

  async getBatchUsers(userIds: string[], page: number, pageSize: number) {
    const response = await this.transport.request<UsersResponse<ErmisChatGenerics>>(
      'post',
      this.baseURL + '/users/batch?page=1&page_size=10000',
      { users: userIds, project_id: this.getProjectId() },
      { params: { page, page_size: pageSize } },
    );
    return response.data || [];
  }

  searchUsers(request: EndUserSearchRequest) {
    return this.transport.request<UsersResponse<ErmisChatGenerics>>('post', this.baseURL + '/users/search', undefined, {
      params: { page: request.page, page_size: request.pageSize, name: request.query, project_id: this.getProjectId() },
    });
  }

  async uploadAvatar(file: File): Promise<Partial<UserResponse<ErmisChatGenerics>>> {
    const formData = new FormData();
    formData.append('avatar', file);
    const response = await this.transport.request<{ avatar: string }>(
      'post',
      this.baseURL + '/users/upload',
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
      },
    );
    return response as Partial<UserResponse<ErmisChatGenerics>>;
  }

  updateProfile(updates: Partial<UserResponse<ErmisChatGenerics>>) {
    return this.transport.request<UserResponse<ErmisChatGenerics>>('patch', this.baseURL + '/users/update', updates);
  }
}
