import { ExtendableGenerics, DefaultGenerics, UserResponse } from './types';

/**
 * TokenManager
 *
 * Manages token storage and retrieval for the chat client.
 */
export class TokenManager<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  loadTokenPromise: Promise<string> | null;
  token?: string;
  user?: UserResponse<ErmisChatGenerics>;

  constructor() {
    this.loadTokenPromise = null;
  }

  /**
   * Set the static string token.
   */
  setTokenOrProvider = async (tokenOrProvider: string | null, user: UserResponse<ErmisChatGenerics>) => {
    this.user = user;

    if (typeof tokenOrProvider === 'string') {
      this.token = tokenOrProvider;
    }

    this.loadTokenPromise = Promise.resolve(this.token as string);
  };

  /**
   * Resets the token manager.
   */
  reset = () => {
    this.token = undefined;
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
