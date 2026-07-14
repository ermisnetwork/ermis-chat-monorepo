import type { DefaultGenerics, ExtendableGenerics, TokenRefreshResult, UserResponse, UsersResponse } from '../types';
import {
  type EndUserAuthApi,
  type EndUserAuthResponse,
  type EndUserClientApi,
  type EndUserSearchRequest,
  type EndUserTransport,
  UnsupportedEndUserFeatureError,
} from './contract';

export type EndUserV1AuthResponse = Partial<EndUserAuthResponse> & { success?: boolean };

export type EndUserV1CompatAuthResponse = EndUserV1AuthResponse & {
  success: boolean;
  token?: string;
  user_id?: string;
};

export type EndUserV1RawUser = {
  id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string;
  services?: string[];
  [key: string]: unknown;
};

export const END_USER_V1_UNSUPPORTED_LISTING =
  'ermis_end_user v1 does not support unrestricted user listing. Use searchUsers(query, limit), queryUser(id), or getBatchUsers(ids).';
export const END_USER_V1_UNSUPPORTED_SSE =
  'ermis_end_user v1 does not support user profile SSE. Profile updates are refreshed through queryUser, searchUsers, getBatchUsers, updateProfile, and uploadAvatar.';
export const END_USER_V1_UNSUPPORTED_EXTERNAL_AUTH =
  'ermis_end_user v1 does not support client-side external_auth token exchange. Call /uss/v1/auth/external from a trusted backend, then pass the returned access_token to connectUser().';
export const END_USER_V1_UNSUPPORTED_WALLET = 'ermis_end_user v1 does not support wallet authentication.';

export function normalizeEndUserV1BaseURL(input: string): string {
  const trimmed = String(input || '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) throw new Error('End-user API base URL is required');
  if (/\/uss\/v1$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return trimmed.replace(/\/v1$/i, '/uss/v1');
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/uss/v1`;
}

function decodeJwtPayload(token?: string): Record<string, unknown> | undefined {
  if (!token || typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function adaptEndUserV1AuthResponse<T extends EndUserV1AuthResponse>(response: T): T & EndUserAuthResponse {
  const accessToken = response.access_token || response.token;
  const jwtPayload = decodeJwtPayload(accessToken);
  const userId =
    response.user_id ||
    response.user?.id ||
    (typeof jwtPayload?.user_id === 'string' ? jwtPayload.user_id : undefined) ||
    (typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : undefined) ||
    (typeof jwtPayload?.id === 'string' ? jwtPayload.id : undefined);
  return {
    ...response,
    success: true,
    ...(accessToken ? { token: accessToken } : {}),
    ...(userId ? { user_id: userId } : {}),
  } as T & EndUserAuthResponse;
}

export function adaptEndUserV1User<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
  rawUser: EndUserV1RawUser | UserResponse<ErmisChatGenerics>,
): UserResponse<ErmisChatGenerics> {
  const raw = rawUser as EndUserV1RawUser & UserResponse<ErmisChatGenerics>;
  const displayName = [raw.display_name, raw.name].find((value) => {
    const name = typeof value === 'string' ? value.trim() : '';
    return Boolean(name && name !== raw.id);
  });
  const avatarUrl = raw.avatar_url ?? raw.avatar;
  return {
    ...raw,
    name: displayName || raw.email || raw.phone || raw.id,
    avatar: avatarUrl || '',
    ...(raw.display_name !== undefined ? { display_name: raw.display_name } : {}),
    ...(raw.avatar_url !== undefined ? { avatar_url: raw.avatar_url } : {}),
  } as UserResponse<ErmisChatGenerics>;
}

export function adaptEndUserV1UsersResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
  rawUsers: Array<EndUserV1RawUser | UserResponse<ErmisChatGenerics>>,
  page = 1,
  limit = rawUsers.length,
): UsersResponse<ErmisChatGenerics> {
  const data = rawUsers.map((user) => adaptEndUserV1User<ErmisChatGenerics>(user));
  const count = data.length;
  return { data, count, total: count, page, page_count: count > 0 && limit > 0 ? Math.ceil(count / limit) : 0 };
}

export function unsupportedEndUserV1Feature(message: string): UnsupportedEndUserFeatureError {
  return new UnsupportedEndUserFeatureError('unrestricted_listing', 'v1', message);
}

export class V1EndUserAuthApi implements EndUserAuthApi {
  readonly mode = 'v1' as const;

  constructor(private readonly baseURL: string, private readonly transport: EndUserTransport) {}

  sendOtpToPhone(identifier: string, method: 'Sms' | 'Voice') {
    return this.postAuth('/auth/otp/request', {
      identifier,
      language: 'en',
      method: method === 'Voice' ? 'voice' : 'sms',
    });
  }

  sendOtpToEmail(identifier: string) {
    return this.postAuth('/auth/otp/request', { identifier, language: 'en', method: 'email' });
  }

  verifyOtp(identifier: string | undefined, _method: 'Sms' | 'Voice' | 'Email' | undefined, otp: string) {
    return this.postAuth('/auth/otp/verify', { identifier, otp });
  }

  loginWithGoogle(token: string) {
    return this.postAuth('/auth/google', { token });
  }

  async getWalletChallenge(_address: string): Promise<unknown> {
    throw new UnsupportedEndUserFeatureError('wallet', 'v1', END_USER_V1_UNSUPPORTED_WALLET);
  }

  async verifyWalletSignature(_address: string | undefined, _signature: string): Promise<EndUserAuthResponse> {
    throw new UnsupportedEndUserFeatureError('wallet', 'v1', END_USER_V1_UNSUPPORTED_WALLET);
  }

  private async postAuth(path: string, data: unknown) {
    const response = await this.transport.request<EndUserV1AuthResponse>('post', this.baseURL + path, data);
    return adaptEndUserV1AuthResponse(response);
  }
}

export class V1EndUserClientApi<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>
  implements EndUserClientApi<ErmisChatGenerics>
{
  readonly mode = 'v1' as const;

  constructor(private readonly baseURL: string, private readonly transport: EndUserTransport) {}

  async refreshToken(refreshToken: string): Promise<TokenRefreshResult> {
    const response = adaptEndUserV1AuthResponse(
      await this.transport.publicRequest<EndUserV1AuthResponse>('post', this.baseURL + '/auth/refresh', {
        refresh_token: refreshToken,
      }),
    );
    if (!response.token) throw new Error('Refresh token response did not include access_token');
    return { ...response, token: response.token, access_token: response.access_token || response.token };
  }

  async externalAuth(_user: UserResponse<ErmisChatGenerics>, _token: string | null): Promise<EndUserAuthResponse> {
    throw new UnsupportedEndUserFeatureError('external_auth', 'v1', END_USER_V1_UNSUPPORTED_EXTERNAL_AUTH);
  }

  getSseUrl(): string {
    throw new UnsupportedEndUserFeatureError('sse', 'v1', END_USER_V1_UNSUPPORTED_SSE);
  }

  async queryUsers(_pageSize: number, _page: number): Promise<UsersResponse<ErmisChatGenerics>> {
    throw new UnsupportedEndUserFeatureError('unrestricted_listing', 'v1', END_USER_V1_UNSUPPORTED_LISTING);
  }

  async queryUser(userId: string) {
    const raw = await this.transport.request<EndUserV1RawUser>('get', `${this.baseURL}/users/${userId}`);
    return adaptEndUserV1User<ErmisChatGenerics>(raw);
  }

  async getBatchUsers(userIds: string[]) {
    const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
    const users: UserResponse<ErmisChatGenerics>[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const chunk = uniqueIds.slice(offset, offset + 100);
      const raw = await this.transport.request<EndUserV1RawUser[]>('post', this.baseURL + '/users/batch', {
        user_ids: chunk,
      });
      users.push(...adaptEndUserV1UsersResponse<ErmisChatGenerics>(raw, 1, chunk.length).data);
    }
    return users;
  }

  async searchUsers(request: EndUserSearchRequest) {
    const limit = Math.min(Math.max(request.pageSize || 20, 1), 100);
    if (!request.query.trim()) return adaptEndUserV1UsersResponse<ErmisChatGenerics>([], 1, limit);
    const raw = await this.transport.request<EndUserV1RawUser[]>('get', this.baseURL + '/users/search', undefined, {
      params: { q: request.query.trim(), limit },
    });
    return adaptEndUserV1UsersResponse<ErmisChatGenerics>(raw, 1, limit);
  }

  async uploadAvatar(file: File) {
    const formData = new FormData();
    formData.append('avatar', file);
    const raw = await this.transport.request<EndUserV1RawUser>('postForm', this.baseURL + '/users/me/avatar', formData);
    return adaptEndUserV1User<ErmisChatGenerics>(raw);
  }

  async updateProfile(updates: Partial<UserResponse<ErmisChatGenerics>>) {
    if (Object.prototype.hasOwnProperty.call(updates, 'about_me')) {
      throw new UnsupportedEndUserFeatureError('profile.about_me', 'v1');
    }
    const body = {
      ...(updates.name !== undefined ? { display_name: updates.name } : {}),
      ...(updates.avatar !== undefined ? { avatar_url: updates.avatar } : {}),
      ...(updates.email !== undefined ? { email: updates.email } : {}),
      ...(updates.phone !== undefined ? { phone: updates.phone } : {}),
      ...(updates.display_name !== undefined ? { display_name: updates.display_name } : {}),
      ...(updates.avatar_url !== undefined ? { avatar_url: updates.avatar_url } : {}),
    };
    const raw = await this.transport.request<EndUserV1RawUser>('patch', this.baseURL + '/users/me', body);
    return adaptEndUserV1User<ErmisChatGenerics>(raw);
  }
}
