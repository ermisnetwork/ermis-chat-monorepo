import { isFunction } from './utils';
import { TokenOrProvider, ExtendableGenerics, DefaultGenerics, UserResponse } from './types';

/**
 * TokenManager
 *
 * Manages token storage, retrieval, and refresh for the chat client.
 * Supports both static tokens and token provider functions for auto-refresh.
 */
export class TokenManager<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  loadTokenPromise: Promise<string> | null;
  type: 'static' | 'provider';
  token?: string;
  tokenProvider?: TokenOrProvider;
  user?: UserResponse<ErmisChatGenerics>;

  constructor() {
    this.loadTokenPromise = null;
    this.type = 'static';
  }

  /**
   * Set the static string token or token provider.
   * Token provider should return a token string or a promise which resolves to string token.
   */
  setTokenOrProvider = async (tokenOrProvider: TokenOrProvider, user: UserResponse<ErmisChatGenerics>) => {
    this.user = user;

    if (isFunction(tokenOrProvider)) {
      this.tokenProvider = tokenOrProvider;
      this.type = 'provider';
    }

    if (typeof tokenOrProvider === 'string') {
      this.token = tokenOrProvider;
      this.type = 'static';
    }

    await this.loadToken();
  };

  /**
   * Resets the token manager.
   * Useful for client disconnection or switching user.
   */
  reset = () => {
    this.token = undefined;
    this.user = undefined;
    this.loadTokenPromise = null;
  };

  /**
   * Resolves when token is ready.
   * Use this to wait if loadToken is in progress.
   */
  tokenReady = () => this.loadTokenPromise;

  /**
   * Fetches a token from tokenProvider function and sets in tokenManager.
   * In case of static token, it will simply resolve to static token.
   */
  loadToken = () => {
    this.loadTokenPromise = new Promise(async (resolve, reject) => {
      if (this.type === 'static') {
        return resolve(this.token as string);
      }

      if (this.tokenProvider && typeof this.tokenProvider !== 'string') {
        try {
          this.token = await this.tokenProvider();
        } catch (e) {
          return reject(new Error(`Call to tokenProvider failed with message: ${e}`));
        }
        resolve(this.token);
      }
    });

    return this.loadTokenPromise;
  };

  /** Returns the current token */
  getToken = () => {
    return this.token;
  };

  isStatic = () => this.type === 'static';
}
