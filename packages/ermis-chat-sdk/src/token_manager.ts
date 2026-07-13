import { ExtendableGenerics, DefaultGenerics, UserResponse } from './types';

/**
 * TokenManager
 *
 * Manages token storage and retrieval for the chat client.
 */
export class TokenManager<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  loadTokenPromise: Promise<string> | null;
  refreshPromise: Promise<unknown> | null;
  refreshToken?: string;
  token?: string;
  user?: UserResponse<ErmisChatGenerics>;

  constructor() {
    this.loadTokenPromise = null;
    this.refreshPromise = null;
  }

  /**
   * Set the static string token.
   */
  setTokenOrProvider = async (
    tokenOrProvider: string | null,
    user: UserResponse<ErmisChatGenerics>,
    options: { refreshToken?: string | null } = {},
  ) => {
    this.user = user;

    if (typeof tokenOrProvider === 'string') {
      this.token = tokenOrProvider;
    }
    if (typeof options.refreshToken === 'string') {
      this.refreshToken = options.refreshToken;
    }

    this.loadTokenPromise = Promise.resolve(this.token as string);
  };

  setTokens = (token: string, refreshToken?: string | null) => {
    this.token = token;
    if (typeof refreshToken === 'string') {
      this.refreshToken = refreshToken;
    }
    this.loadTokenPromise = Promise.resolve(this.token);
  };

  /**
   * Resets the token manager.
   */
  reset = () => {
    this.token = undefined;
    this.refreshToken = undefined;
    this.refreshPromise = null;
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

  getRefreshToken = () => {
    return this.refreshToken;
  };
}
