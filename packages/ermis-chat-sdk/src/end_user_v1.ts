import type { DefaultGenerics, ExtendableGenerics, UserResponse, UsersResponse } from './types';

export type EndUserV1AuthResponse = {
  user_id?: string;
  access_token?: string;
  refresh_token?: string;
  services?: string[];
  token?: string;
  success?: boolean;
  message?: string;
  data?: unknown;
  user?: { id?: string };
  [key: string]: unknown;
};

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
  if (!trimmed) {
    throw new Error('End-user API base URL is required');
  }
  if (/\/uss\/v1$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return trimmed.replace(/\/v1$/i, '/uss/v1');
  }
  if (/\/v\d+$/i.test(trimmed)) {
    return trimmed;
  }
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

export function adaptEndUserV1AuthResponse<T extends EndUserV1AuthResponse>(
  response: T,
): T & {
  success: boolean;
  token?: string;
  user_id?: string;
} {
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
  };
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
  return {
    data,
    count,
    total: count,
    page,
    page_count: count > 0 && limit > 0 ? Math.ceil(count / limit) : 0,
  };
}

export function unsupportedEndUserV1Feature(message: string): Error {
  return new Error(message);
}
