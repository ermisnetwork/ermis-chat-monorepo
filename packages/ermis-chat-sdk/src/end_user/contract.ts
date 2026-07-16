import type { AxiosRequestConfig } from 'axios';
import type {
  DefaultGenerics,
  EndUserApiMode,
  ExtendableGenerics,
  TokenRefreshResult,
  UserResponse,
  UsersResponse,
} from '../types';

export type { EndUserApiMode } from '../types';

export type EndUserFeature = 'external_auth' | 'profile.about_me' | 'sse' | 'unrestricted_listing' | 'wallet';

export class UnsupportedEndUserFeatureError extends Error {
  readonly code = 'END_USER_FEATURE_UNSUPPORTED';

  constructor(readonly feature: EndUserFeature, readonly endUserApiMode: EndUserApiMode, message?: string) {
    super(message || `End-user API ${endUserApiMode} does not support ${feature}`);
    this.name = 'UnsupportedEndUserFeatureError';
  }
}

export type EndUserAuthResponse = {
  user_id?: string;
  access_token?: string;
  refresh_token?: string;
  services?: string[];
  token?: string;
  success: boolean;
  message?: string;
  data?: unknown;
  user?: { id?: string };
  [key: string]: unknown;
};

export type EndUserRequestMethod = 'get' | 'post' | 'postForm' | 'patch';

export type EndUserTransport = {
  request<T>(method: EndUserRequestMethod, url: string, data?: unknown, options?: AxiosRequestConfig): Promise<T>;
  publicRequest<T>(method: EndUserRequestMethod, url: string, data?: unknown, options?: AxiosRequestConfig): Promise<T>;
};

export interface EndUserAuthApi {
  readonly mode: EndUserApiMode;
  sendOtpToPhone(identifier: string, method: 'Sms' | 'Voice'): Promise<EndUserAuthResponse>;
  sendOtpToEmail(identifier: string): Promise<EndUserAuthResponse>;
  verifyOtp(
    identifier: string | undefined,
    method: 'Sms' | 'Voice' | 'Email' | undefined,
    otp: string,
  ): Promise<EndUserAuthResponse>;
  loginWithGoogle(token: string): Promise<EndUserAuthResponse>;
  getWalletChallenge(address: string): Promise<unknown>;
  verifyWalletSignature(address: string | undefined, signature: string): Promise<EndUserAuthResponse>;
}

export type EndUserSearchRequest = {
  query: string;
  page: number;
  pageSize: number;
};

export interface EndUserClientApi<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  readonly mode: EndUserApiMode;
  refreshToken(refreshToken: string): Promise<TokenRefreshResult>;
  externalAuth(user: UserResponse<ErmisChatGenerics>, token: string | null): Promise<EndUserAuthResponse>;
  getSseUrl(): string;
  queryUsers(pageSize: number, page: number): Promise<UsersResponse<ErmisChatGenerics>>;
  queryUser(userId: string): Promise<UserResponse<ErmisChatGenerics>>;
  getBatchUsers(userIds: string[], page: number, pageSize: number): Promise<UserResponse<ErmisChatGenerics>[]>;
  searchUsers(request: EndUserSearchRequest): Promise<UsersResponse<ErmisChatGenerics>>;
  uploadAvatar(file: File): Promise<Partial<UserResponse<ErmisChatGenerics>>>;
  updateProfile(updates: Partial<UserResponse<ErmisChatGenerics>>): Promise<UserResponse<ErmisChatGenerics>>;
}
