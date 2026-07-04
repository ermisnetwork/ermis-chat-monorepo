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
