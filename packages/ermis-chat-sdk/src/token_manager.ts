import { ExtendableGenerics, DefaultGenerics, RefreshTokenInput, RefreshTokenProvider, UserResponse } from './types';

/**
 * TokenManager
 *
 * Manages token storage and retrieval for the chat client.
 */
export class TokenManager<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  loadTokenPromise: Promise<string> | null;
  refreshToken?: string;
  refreshTokenProvider?: RefreshTokenProvider;
  token?: string;
  user?: UserResponse<ErmisChatGenerics>;

  constructor() {
    this.loadTokenPromise = null;
  }

  /**
   * Set the static string token.
   */
  setTokenOrProvider = async (
    tokenOrProvider: string | null,
    user: UserResponse<ErmisChatGenerics>,
    refreshTokenOrProvider?: RefreshTokenInput,
  ) => {
    this.user = user;

    if (typeof tokenOrProvider === 'string') {
      this.token = tokenOrProvider;
    }
    if (refreshTokenOrProvider !== undefined) {
      this.setRefreshTokenOrProvider(refreshTokenOrProvider);
    }

    this.loadTokenPromise = Promise.resolve(this.token as string);
  };

  /**
   * Replace the active access token after a successful refresh.
   */
  setToken = (token: string) => {
    this.token = token;
    this.loadTokenPromise = Promise.resolve(token);
  };

  /**
   * Set the refresh token or a provider returning the latest refresh token.
   */
  setRefreshTokenOrProvider = (refreshTokenOrProvider?: RefreshTokenInput) => {
    if (refreshTokenOrProvider === undefined) return;

    if (refreshTokenOrProvider === null) {
      this.refreshToken = undefined;
      this.refreshTokenProvider = undefined;
      return;
    }

    if (typeof refreshTokenOrProvider === 'function') {
      this.refreshToken = undefined;
      this.refreshTokenProvider = refreshTokenOrProvider;
      return;
    }

    this.refreshToken = refreshTokenOrProvider || undefined;
    this.refreshTokenProvider = undefined;
  };

  /**
   * Returns the current refresh token, resolving a provider when configured.
   */
  getRefreshToken = async () => {
    if (this.refreshTokenProvider) {
      const token = await this.refreshTokenProvider();
      return token || undefined;
    }
    return this.refreshToken;
  };

  /** Untrusted scheduling hint only. Bellboy uses millisecond exp; some issuers use seconds. */
  isAccessTokenExpired = (now = Date.now()): boolean => {
    if (!this.token || !Number.isFinite(now)) return false;
    try {
      const parts = this.token.replace(/^Bearer\s+/i, '').split('.');
      if (parts.length !== 3 || parts[1].length > 16384) return false;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
      if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= 0) return false;
      const expiresAt = payload.exp >= 100000000000 ? payload.exp : payload.exp * 1000;
      return now >= expiresAt;
    } catch { return false; }
  };

  /**
   * Resets the token manager.
   */
  reset = () => {
    this.token = undefined;
    this.refreshToken = undefined;
    this.refreshTokenProvider = undefined;
    this.user = undefined;
    this.loadTokenPromise = null;
  };

  /**
   * Resolves when token is ready.
   */
  tokenReady = () => this.loadTokenPromise;

  /** Returns the current token */
  getToken = () => {
    return this.token;
  };
}
