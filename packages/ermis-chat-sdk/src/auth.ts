import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { APIErrorResponse, ErmisAuthProviderConfig, ErmisChatOptions, ErrorFromResponse, Logger } from './types';
import { chatCodes, randomId, retryInterval, sleep } from './utils';
import https from 'https';
import { isErrorResponse } from './errors';
import { getLogger, setSdkLogger } from './logger';
import {
  END_USER_V1_UNSUPPORTED_WALLET,
  adaptEndUserV1AuthResponse,
  normalizeEndUserV1BaseURL,
  unsupportedEndUserV1Feature,
  type EndUserV1AuthResponse,
  type EndUserV1CompatAuthResponse,
} from './end_user_v1';

type ResolvedAuthProviderConfig = {
  apiKey: string;
  baseURL: string;
  options: ErmisChatOptions;
  selfHosted: boolean;
};

function resolveAuthProviderConfig(
  apiKeyOrConfig: string | ErmisAuthProviderConfig,
  baseURL?: string,
  options?: ErmisChatOptions,
): ResolvedAuthProviderConfig {
  if (typeof apiKeyOrConfig === 'object' && apiKeyOrConfig !== null) {
    const { apiKey = '', baseURL: configBaseURL, ...inputOptions } = apiKeyOrConfig;
    const selfHosted = inputOptions.selfHosted === true;

    if (!configBaseURL) {
      throw new Error('ErmisAuthProvider config requires baseURL');
    }
    if (!selfHosted && !apiKey) {
      throw new Error('ErmisAuthProvider cloud mode requires apiKey');
    }

    return {
      apiKey,
      baseURL: configBaseURL,
      options: inputOptions,
      selfHosted,
    };
  }

  const inputOptions = options || {};
  const selfHosted = inputOptions.selfHosted === true;

  if (!baseURL) {
    throw new Error('ErmisAuthProvider constructor requires baseURL');
  }
  if (!selfHosted && !apiKeyOrConfig) {
    throw new Error('ErmisAuthProvider cloud mode requires apiKey');
  }

  return {
    apiKey: apiKeyOrConfig || '',
    baseURL,
    options: inputOptions,
    selfHosted,
  };
}

export class ErmisAuthProvider {
  apiKey: string;
  baseURL?: string;
  options?: ErmisChatOptions;
  axiosInstance: AxiosInstance;
  disconnected: boolean;
  browser: boolean;
  node: boolean;
  logger: Logger;
  consecutiveFailures: number;
  selfHosted: boolean;
  userAgent?: string;
  /** Last identifier (phone or email) used for OTP */
  lastIdentifier?: string;
  /**
   * The last OTP method used ('Sms', 'Voice', or 'Email').
   * Used to verify OTP for the correct method.
   */
  lastMethod?: 'Sms' | 'Voice' | 'Email';
  /** Wallet address used for wallet authentication */
  address?: string;

  constructor(config: ErmisAuthProviderConfig);
  constructor(apiKey: string, baseURL: string, options?: ErmisChatOptions);
  constructor(apiKeyOrConfig: string | ErmisAuthProviderConfig, baseURL?: string, options?: ErmisChatOptions) {
    const resolvedConfig = resolveAuthProviderConfig(apiKeyOrConfig, baseURL, options);
    const inputOptions = resolvedConfig.options;
    this.apiKey = resolvedConfig.apiKey;
    this.selfHosted = resolvedConfig.selfHosted;
    this.logger = getLogger(inputOptions.logger);
    setSdkLogger(inputOptions.logger);
    this.logger('info', 'auth:constructor - userBaseURL configured', { userBaseURL: inputOptions.userBaseURL });

    this.baseURL = normalizeEndUserV1BaseURL(inputOptions.userBaseURL || resolvedConfig.baseURL);

    this.browser = typeof inputOptions.browser !== 'undefined' ? inputOptions.browser : typeof window !== 'undefined';
    this.node = !this.browser;
    this.options = {
      // timeout: 3000,
      withCredentials: false, // making sure cookies are not sent
      warmUp: false,
      recoverStateOnReconnect: true,
      ...inputOptions,
    };
    if (this.node && !this.options.httpsAgent) {
      this.options.httpsAgent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 3000,
      });
    }
    this.axiosInstance = axios.create(this.options);
    this.consecutiveFailures = 0;
    this.disconnected = false;
  }

  _logApiRequest(
    type: string,
    url: string,
    data: unknown,
    config: AxiosRequestConfig & {
      config?: AxiosRequestConfig & { maxBodyLength?: number };
    },
  ) {
    this.logger(
      'info',
      `client: ${type} - Request - ${url}- ${JSON.stringify(data)} - ${JSON.stringify(config.params)}`,
      {
        tags: ['api', 'api_request', 'client'],
        url,
        payload: data,
        config,
      },
    );
  }

  _logApiResponse<T>(type: string, url: string, response: AxiosResponse<T>) {
    this.logger('info', `client:${type} - Response - url: ${url} > status ${response.status}`, {
      tags: ['api', 'api_response', 'client'],
      url,
      response,
    });
  }

  _logApiError(type: string, url: string, error: unknown, options: unknown) {
    this.logger(
      'error',
      `client:${type} - Error: ${JSON.stringify(error)} - url: ${url} - options: ${JSON.stringify(options)}`,
      {
        tags: ['api', 'api_response', 'client'],
        url,
        error,
      },
    );
  }

  doAxiosRequest = async <T>(
    type: string,
    url: string,
    data?: unknown,
    options: AxiosRequestConfig & {
      config?: AxiosRequestConfig & { maxBodyLength?: number };
    } = {},
  ): Promise<T> => {
    const requestConfig = this._enrichAxiosOptions(options);

    try {
      let response: AxiosResponse<T>;
      this._logApiRequest(type, url, data, requestConfig);
      switch (type) {
        case 'get':
          response = await this.axiosInstance.get(url, requestConfig);
          break;
        case 'delete':
          response = await this.axiosInstance.delete(url, requestConfig);
          break;
        case 'post':
          response = await this.axiosInstance.post(url, data, requestConfig);
          break;
        case 'postForm':
          response = await this.axiosInstance.postForm(url, data, requestConfig);
          break;
        case 'put':
          response = await this.axiosInstance.put(url, data, requestConfig);
          break;
        case 'patch':
          response = await this.axiosInstance.patch(url, data, requestConfig);
          break;
        case 'options':
          response = await this.axiosInstance.options(url, requestConfig);
          break;
        default:
          throw new Error('Invalid request type');
      }
      this._logApiResponse<T>(type, url, response);
      this.consecutiveFailures = 0;
      return this.handleResponse(response);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any /**TODO: generalize error types  */) {
      e.client_request_id = requestConfig.headers?.['x-client-request-id'];
      this._logApiError(type, url, e, options);
      this.consecutiveFailures += 1;
      if (e.response) {
        /** connection_fallback depends on this token expiration logic */
        if (e.response.data.code === chatCodes.TOKEN_EXPIRED) {
          if (this.consecutiveFailures > 1) {
            await sleep(retryInterval(this.consecutiveFailures));
          }
          return await this.doAxiosRequest<T>(type, url, data, requestConfig);
        }
        return this.handleResponse(e.response);
      } else {
        throw e as AxiosError<APIErrorResponse>;
      }
    }
  };

  get<T>(url: string, params?: AxiosRequestConfig['params']) {
    return this.doAxiosRequest<T>('get', url, null, { params });
  }

  put<T>(url: string, data?: unknown) {
    return this.doAxiosRequest<T>('put', url, data);
  }

  post<T>(url: string, data?: unknown, params?: AxiosRequestConfig['params']) {
    return this.doAxiosRequest<T>('post', url, data, { params });
  }

  patch<T>(url: string, data?: unknown) {
    return this.doAxiosRequest<T>('patch', url, data);
  }

  delete<T>(url: string, params?: AxiosRequestConfig['params']) {
    return this.doAxiosRequest<T>('delete', url, null, { params });
  }
  errorFromResponse(response: AxiosResponse<APIErrorResponse>): ErrorFromResponse<APIErrorResponse> {
    let err: ErrorFromResponse<APIErrorResponse>;
    err = new ErrorFromResponse(`ErmisChat error HTTP code: ${response.status}`);
    if (response.data && response.data.code) {
      err = new Error(`ErmisChat error code ${response.data.code}: ${response.data.message}`);
      err.code = response.data.code;
    }
    err.response = response;
    err.status = response.status;
    return err;
  }

  handleResponse<T>(response: AxiosResponse<T>) {
    const data = response.data;
    if (isErrorResponse(response)) {
      throw this.errorFromResponse(response);
    }
    return data;
  }

  getUserAgent() {
    return (
      this.userAgent || `ermis-chat-sdk-javascript-client-${this.node ? 'node' : 'browser'}-${process.env.PKG_VERSION}`
    );
  }
  setUserAgent(userAgent: string) {
    this.userAgent = userAgent;
  }
  _enrichAxiosOptions(
    options: AxiosRequestConfig & { config?: AxiosRequestConfig } = {
      params: {},
      headers: {},
      config: {},
    },
  ): AxiosRequestConfig {
    let signal: AbortSignal | null = null;

    if (!options.headers?.['x-client-request-id']) {
      options.headers = {
        ...options.headers,
        'x-client-request-id': randomId(),
      };
    }
    const {
      params: axiosRequestConfigParams,
      headers: axiosRequestConfigHeaders,
      ...axiosRequestConfigRest
    } = this.options?.axiosRequestConfig || {};

    let user_service_params = {
      // api_key: this.key,
      ...options.params,
      ...(axiosRequestConfigParams || {}),
    };

    return {
      params: user_service_params,
      headers: {
        'X-Stream-Client': this.getUserAgent(),
        ...options.headers,
        ...(axiosRequestConfigHeaders || {}),
      },
      ...(signal ? { signal } : {}),
      ...options.config,
      ...(axiosRequestConfigRest || {}),
    };
  }

  /**
   * Send OTP to a phone number.
   * @param identifier Phone number
   * @param language Language code (e.g. 'En', 'Vi')
   * @param method Method type (e.g. 'Sms', 'Voice')
   */
  async sendOtpToPhone(identifier: string, method: 'Sms' | 'Voice'): Promise<EndUserV1CompatAuthResponse> {
    this.lastIdentifier = identifier;
    this.lastMethod = method;
    const data = {
      identifier,
      language: 'en',
      method: method === 'Voice' ? 'voice' : 'sms',
    };
    const response = await this.post<EndUserV1AuthResponse>(this.baseURL + '/auth/otp/request', data);
    return adaptEndUserV1AuthResponse(response);
  }

  /**
   * Send OTP to a email.
   * @param identifier Email address
   * @param language Language code (e.g. 'En', 'Vi')
   * @param method Method type (e.g. 'Email')
   */
  async sendOtpToEmail(identifier: string): Promise<EndUserV1CompatAuthResponse> {
    this.lastIdentifier = identifier;
    this.lastMethod = 'Email';
    const data = {
      identifier,
      language: 'en',
      method: 'email',
    };
    const response = await this.post<EndUserV1AuthResponse>(this.baseURL + '/auth/otp/request', data);
    return adaptEndUserV1AuthResponse(response);
  }

  /**
   * Verify OTP for phone or email.
   * @param otp OTP code
   */
  async verifyOtp(otp: string): Promise<EndUserV1CompatAuthResponse> {
    const data = {
      identifier: this.lastIdentifier,
      otp,
    };

    const response = await this.post<EndUserV1AuthResponse>(this.baseURL + '/auth/otp/verify', data);
    return adaptEndUserV1AuthResponse(response);
  }

  /**
   * Login with Google.
   * @param token Google OAuth token
   * @param apikey API key
   */
  async loginWithGoogle(token: string): Promise<EndUserV1CompatAuthResponse> {
    const data = {
      token,
    };
    const response = await this.post<EndUserV1AuthResponse>(this.baseURL + '/auth/google', data);
    return adaptEndUserV1AuthResponse(response);
  }

  /**
   * Get challenge for wallet login.
   * @param address Wallet address
   * @param apiKey API key
   */
  async getWalletChallenge(address: string): Promise<any> {
    this.address = address;
    throw unsupportedEndUserV1Feature(END_USER_V1_UNSUPPORTED_WALLET);
  }

  /**
   * Verify wallet signature after receiving the challenge.
   * @param address Wallet address
   * @param signature Signature generated by the wallet
   * @param nonce Nonce used in the challenge
   * @returns Verification result and token if successful
   */
  async verifyWalletSignature(_signature: string): Promise<{ success: boolean; token?: string; message?: string }> {
    throw unsupportedEndUserV1Feature(END_USER_V1_UNSUPPORTED_WALLET);
  }
}
