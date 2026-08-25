/* eslint no-unused-vars: "off" */
/* global process */

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import https from 'https';
import WebSocket from 'isomorphic-ws';

import { Channel } from './channel';
import { ClientState } from './client_state';
import { StableWSConnection } from './connection';
import { E2EE_BYTES_HEADER, E2EE_BYTES_WIRE_FORMAT, normalizeE2eeEventBytes } from './encryption/encoding';
import { IndexedDBEncryptionStorage } from './encryption/storage';
import { IndexedDBUserCache } from './user_cache';
import { getLogger, setSdkLogger } from './logger';
import { StandardAttachmentUploadStorage } from './standard_attachment_upload_storage';

import { TokenManager } from './token_manager';

import { isErrorResponse } from './errors';
import { EventSourcePolyfill } from 'event-source-polyfill';
import {
  createEndUserClientApi,
  resolveEndUserApiMode,
  resolveEndUserBaseURL,
  type EndUserClientApi,
  type EndUserRequestMethod,
} from './end_user';
import {
  addFileToFormData,
  axiosParamsSerializer,
  chatCodes,
  enrichWithUserInfo,
  ensureMembersUserInfoLoaded,
  getDirectChannelImage,
  getDirectChannelName,
  getLatestCreatedAt,
  randomId,
} from './utils';

import {
  APIErrorResponse,
  APIResponse,
  ChannelAPIResponse,
  ChannelData,
  ChannelFilters,
  ChannelSort,
  ChannelStateOptions,
  ConnectAPIResponse,
  ConnectUserOptions,
  DefaultGenerics,
  EndUserApiMode,
  ErrorFromResponse,
  Event,
  EventHandler,
  ExtendableGenerics,
  Logger,
  QueryChannelsAPIResponse,
  RefreshTokenInput,
  SendFileAPIResponse,
  TokenRefreshResult,
  ErmisChatOptions,
  UserResponse,
  ContactResponse,
  UsersResponse,
  ContactResult,
  Contact,
  ErmisChatConfig,
  GlobalSyncRequest,
  GlobalSyncResponse,
  EventSyncResponse,
  type SyncStateRecord,
} from './types';

function isString(x: unknown): x is string {
  return typeof x === 'string' || x instanceof String;
}

const SYNC_STATE_VERSION = 2;

type ResolvedErmisChatConfig = {
  apiKey: string;
  projectId: string;
  baseURL: string;
  options: ErmisChatOptions;
  selfHosted: boolean;
};

function resolveErmisChatConfig(
  apiKeyOrConfig: string | ErmisChatConfig,
  projectId?: string,
  baseURL?: string,
  options?: ErmisChatOptions,
): ResolvedErmisChatConfig {
  if (typeof apiKeyOrConfig === 'object' && apiKeyOrConfig !== null) {
    const { apiKey = '', projectId: configProjectId = '', baseURL: configBaseURL, ...inputOptions } = apiKeyOrConfig;
    const selfHosted = inputOptions.selfHosted === true;

    if (!configBaseURL) {
      throw new Error('ErmisChat config requires baseURL');
    }
    if (!selfHosted && (!apiKey || !configProjectId)) {
      throw new Error('ErmisChat cloud mode requires apiKey and projectId');
    }

    return {
      apiKey,
      projectId: configProjectId,
      baseURL: configBaseURL,
      options: inputOptions,
      selfHosted,
    };
  }

  const inputOptions = options || {};
  const selfHosted = inputOptions.selfHosted === true;

  if (!baseURL) {
    throw new Error('ErmisChat constructor requires baseURL');
  }
  if (!selfHosted && (!apiKeyOrConfig || !projectId)) {
    throw new Error('ErmisChat cloud mode requires apiKey and projectId');
  }

  return {
    apiKey: apiKeyOrConfig || '',
    projectId: projectId || '',
    baseURL,
    options: inputOptions,
    selfHosted,
  };
}

/**
 * The ErmisChat Client represents the connection securely established between your application
 * and the Ermis core servers. It acts as the primary access point for real-time messaging,
 * presence updates, call management, and channel querying.
 *
 * It is highly recommended to instantiate this class as a Singleton via `ErmisChat.getInstance()`.
 */
export class ErmisChat<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  private static _instance?: unknown | ErmisChat; // type is undefined|ErmisChat, unknown is due to TS limitations with statics

  /** A map of active channels currently tracked by the client, keyed by Channel ID. */
  activeChannels: {
    [key: string]: Channel<ErmisChatGenerics>;
  };
  /** The internal configured Axios instance used for REST API requests. */
  axiosInstance: AxiosInstance;
  /** The primary base URL for REST API communication. */
  baseURL?: string;
  /** The specific base URL for standard user-focused REST calls. */
  userBaseURL?: string;
  /** True when the SDK is executed inside a browser environment. */
  browser: boolean;
  cleaningIntervalRef?: NodeJS.Timeout;
  clientID?: string;
  apiKey: string;
  projectId: string;
  selfHosted: boolean;
  endUserApiMode: EndUserApiMode;
  /** Internal mapped registry of event listeners. */
  listeners: Record<string, Array<(event: Event<ErmisChatGenerics>) => void>>;
  logger: Logger;
  /** Whether the client should automatically fetch missing messages upon unexpected disconnects. */
  recoverStateOnReconnect?: boolean;
  /** True when the SDK is executed in a NodeJS environment constraint. */
  node: boolean;
  /** Custom options passed during client initialization. */
  options: ErmisChatOptions;
  setUserPromise: ConnectAPIResponse<ErmisChatGenerics> | null;
  /** Centralized global state orchestrating user and client metadata. */
  state: ClientState<ErmisChatGenerics>;
  tokenManager: TokenManager<ErmisChatGenerics>;
  /** The globally authenticated current user object. */
  user?: UserResponse<ErmisChatGenerics>;
  userAgent?: string;
  /** The unique ID of the current authenticated user. */
  userID?: string;
  /** The configured WebSocket endpoint base URL for realtime subscriptions. */
  wsBaseURL?: string;
  /** The active WebSocket connection controller. */
  wsConnection: StableWSConnection<ErmisChatGenerics> | null;
  wsPromise: ConnectAPIResponse<ErmisChatGenerics> | null;
  /** Tracks consecutive REST API failures for exponential backoff purposes. */
  consecutiveFailures: number;
  defaultWSTimeout: number;
  /** Device ID used by encryption/E2EE sessions and sent to Bellboy over WS/HTTP. */
  deviceId?: string;
  /** Latest current-device KeyPackage count reported by health.check. */
  latestKeyPackagesRemaining?: number;
  /** Encryption Manager instance set by EncryptionManager.initialize() for E2EE event handling. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encryptionManager?: any;
  /** Message storage for offline persistence. Initialized on connectUser() for ALL channels. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messageStorage?: any;
  /** Browser persistence for resumable non-E2EE attachment uploads. */
  standardAttachmentUploadStorage?: StandardAttachmentUploadStorage;
  private userCache?: IndexedDBUserCache<ErmisChatGenerics>;
  private userCacheKey?: string;
  private refreshTokenPromise: Promise<TokenRefreshResult> | null = null;
  private endUserApi!: EndUserClientApi<ErmisChatGenerics>;

  private eventSource: EventSourcePolyfill | null = null;

  // ─── Event Sourcing Sync State ──────────────────────────────────────────────
  /** Cursor for incremental removed-channels sync across performSync() calls. */
  private _removedSyncCursor?: { removed_at: string; event_id: string };
  /** Guard to prevent concurrent performSync() calls (debounce). */
  private _syncInProgress = false;
  /** Promise for the currently running sync, so callers can await the same run. */
  private _syncPromise: Promise<void> | null = null;
  /** Timestamp of the last successful performSync to throttle redundant bursts. */
  private _lastSyncCompletedAt = 0;

  /**
   * Initializes a new Ermis Chat Client instance.
   *
   * @param apiKey    - Your public Sub2s API Key.
   * @param projectId - Your specific Project UUID pointing to the app config.
   * @param baseURL   - The API base endpoint assigned to your project.
   * @param options   - Additional connection rules and configuration options.
   */
  constructor(config: ErmisChatConfig);
  constructor(apiKey: string, projectId: string, baseURL: string, options?: ErmisChatOptions);
  constructor(
    apiKeyOrConfig: string | ErmisChatConfig,
    projectId?: string,
    baseURL?: string,
    options?: ErmisChatOptions,
  ) {
    const resolvedConfig = resolveErmisChatConfig(apiKeyOrConfig, projectId, baseURL, options);

    this.apiKey = resolvedConfig.apiKey;
    this.projectId = resolvedConfig.projectId;
    this.selfHosted = resolvedConfig.selfHosted;
    this.listeners = {};
    this.state = new ClientState<ErmisChatGenerics>();

    const inputOptions = resolvedConfig.options;
    this.endUserApiMode = resolveEndUserApiMode(inputOptions.endUserApiMode, this.selfHosted);

    this.browser = typeof inputOptions.browser !== 'undefined' ? inputOptions.browser : typeof window !== 'undefined';
    this.node = !this.browser;

    this.options = {
      withCredentials: false,
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

    this.setBaseURL(resolvedConfig.baseURL);

    // WS connection is initialized when setUser is called
    this.wsConnection = null;
    this.wsPromise = null;
    this.setUserPromise = null;
    // keeps a reference to all the channels that are in use
    this.activeChannels = {};

    this.tokenManager = new TokenManager();
    this.tokenManager.setRefreshTokenOrProvider(this.options.refreshToken);
    this.consecutiveFailures = 0;
    this.defaultWSTimeout = 15000;

    this.axiosInstance.defaults.paramsSerializer = axiosParamsSerializer;

    this.logger = getLogger(inputOptions.logger);
    setSdkLogger(inputOptions.logger);
    this.logger('info', 'client:constructor - end-user API selected', { endUserApiMode: this.endUserApiMode });
    this.recoverStateOnReconnect = this.options.recoverStateOnReconnect;
  }

  /**
   * Retrieves the globally registered Singleton instance of the ErmisChat client.
   * If the instance lacks existence, it initializes a new one.
   *
   * @param key       - Your public Sub2s API Key.
   * @param projectId - Your specific Project UUID.
   * @param baseURL   - The API base endpoint.
   * @param options   - Connection options.
   * @returns           The shared ErmisChat client instance.
   */
  public static getInstance<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
    config: ErmisChatConfig,
  ): ErmisChat<ErmisChatGenerics>;
  public static getInstance<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
    key: string,
    projectId: string,
    baseURL: string,
    options?: ErmisChatOptions,
  ): ErmisChat<ErmisChatGenerics>;
  public static getInstance<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
    keyOrConfig: string | ErmisChatConfig,
    projectId?: string,
    baseURL?: string,
    options?: ErmisChatOptions,
  ): ErmisChat<ErmisChatGenerics> {
    if (!ErmisChat._instance) {
      ErmisChat._instance =
        typeof keyOrConfig === 'object'
          ? new ErmisChat<ErmisChatGenerics>(keyOrConfig)
          : new ErmisChat<ErmisChatGenerics>(keyOrConfig, projectId as string, baseURL as string, options);
    }

    return ErmisChat._instance as ErmisChat<ErmisChatGenerics>;
  }

  async refreshNewToken(refreshToken: string): Promise<TokenRefreshResult> {
    return this.endUserApi.refreshToken(refreshToken);
  }

  setRefreshToken(refreshTokenOrProvider?: RefreshTokenInput) {
    this.tokenManager.setRefreshTokenOrProvider(refreshTokenOrProvider);
  }

  private _dispatchRefreshFailed(error: unknown, reason = 'refresh_failed') {
    const status = (error as any)?.response?.status || (error as any)?.status;
    this.dispatchEvent({ type: 'auth.refresh_failed', reason, status } as Event<ErmisChatGenerics>);
  }

  async refreshAccessToken(): Promise<TokenRefreshResult> {
    if (this.refreshTokenPromise) return this.refreshTokenPromise;

    const refreshPromise = (async () => {
      const refreshToken = await this.tokenManager.getRefreshToken();
      if (!refreshToken) {
        const error = new Error('No refresh token available');
        this._dispatchRefreshFailed(error, 'missing_refresh_token');
        throw error;
      }

      const refreshed = await this.refreshNewToken(refreshToken);
      this.tokenManager.setToken(refreshed.token);
      if (refreshed.refresh_token) {
        this.tokenManager.setRefreshTokenOrProvider(refreshed.refresh_token);
      }
      if (this.options.onTokenRefresh) {
        try {
          await this.options.onTokenRefresh(refreshed);
        } catch (callbackError) {
          this.logger('warn', 'client:refreshAccessToken() - onTokenRefresh callback failed', {
            tags: ['api', 'auth', 'client'],
            error: callbackError,
          });
        }
      }

      this.logger('info', 'client:refreshAccessToken() - refreshed access token', {
        tags: ['api', 'auth', 'client'],
      });
      this.dispatchEvent({
        type: 'auth.token_refreshed',
        token: refreshed.token,
        refresh_token: refreshed.refresh_token,
        user_id: refreshed.user_id,
      } as unknown as Event<ErmisChatGenerics>);
      return refreshed;
    })().catch((error) => {
      if ((error as Error).message !== 'No refresh token available') this._dispatchRefreshFailed(error);
      throw error;
    });

    this.refreshTokenPromise = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (this.refreshTokenPromise === refreshPromise) {
        this.refreshTokenPromise = null;
      }
    }
  }

  getAuthType() {
    return 'jwt';
  }

  setBaseURL(baseURL: string) {
    this.baseURL = baseURL;
    this.userBaseURL = resolveEndUserBaseURL(this.options.userBaseURL || baseURL, this.endUserApiMode);

    this.endUserApi = createEndUserClientApi<ErmisChatGenerics>({
      mode: this.endUserApiMode,
      baseURL: this.userBaseURL,
      apiKey: this.apiKey,
      getProjectId: () => this._projectIdForInternalUse(),
      transport: {
        request: <T>(method: EndUserRequestMethod, url: string, data?: unknown, requestOptions = {}) =>
          this.doAxiosRequest<T>(method, url, data, requestOptions),
        publicRequest: <T>(method: EndUserRequestMethod, url: string, data?: unknown, requestOptions = {}) =>
          this._doPublicEndUserRequest<T>(method, url, data, requestOptions),
      },
    });

    this.wsBaseURL = this.baseURL.replace('http', 'ws').replace(':3030', ':8800');
  }

  _projectIdForInternalUse() {
    return this.projectId || undefined;
  }

  _requireProjectId(context: string) {
    if (this.projectId) return this.projectId;

    throw new Error(
      `${context} requires projectId. In self-hosted mode, call connectUser first so Bellboy returns project_id via health.check, or pass projectId in the ErmisChat config.`,
    );
  }

  _withProjectId<T extends Record<string, unknown>>(payload: T): T & { project_id?: string } {
    if (this.selfHosted) return payload;

    return {
      ...payload,
      project_id: this.projectId,
    };
  }

  async getExternalAuthToken(user: UserResponse<ErmisChatGenerics>, token: string | null) {
    return this.endUserApi.externalAuth(user, token);
  }

  /**
   * Connects a user to the Sub2s and establishes the WebSocket connection.
   * This is the primary method to authenticate your client application.
   *
   * @param user                - The User object containing `id`, `name`, and optional `avatar`.
   * @param userTokenOrProvider - The JWT token or an async token provider function.
   * @param options             - External auth and refresh token options.
   * @returns                     A promise resolving to the API connection response once authenticated.
   */
  connectUser = async (
    user: UserResponse<ErmisChatGenerics>,
    userTokenOrProvider: string | null,
    options: ConnectUserOptions = {},
  ) => {
    this.logger('info', 'client:connectUser() - started', {
      tags: ['connection', 'client'],
    });
    if (!user.id) {
      throw new Error('The "id" field on the user is missing');
    }

    let connectionUser = user;
    let connectionToken = userTokenOrProvider;

    if (options.externalAuth) {
      const externalUser = await this.getExternalAuthToken(user, userTokenOrProvider);
      connectionUser = { ...user, ...(externalUser.user || {}), id: externalUser.user_id || user.id };
      connectionToken = externalUser.token || externalUser.access_token || userTokenOrProvider;
    }

    /**
     * Calling connectUser multiple times is potentially the result of a  bad integration, however,
     * If the user id remains the same we don't throw error
     */
    if (this.userID === connectionUser.id && this.setUserPromise) {
      this.logger(
        'warn',
        'Consecutive calls to connectUser is detected, ideally you should only call this function once in your app.',
        { tags: ['connection', 'client'] },
      );
      return this.setUserPromise;
    }

    if (this.userID) {
      throw new Error(
        'Use client.disconnect() before trying to connect as a different user. connectUser was called twice.',
      );
    }

    if (this.node && !this.options.allowServerSideConnect) {
      this.logger(
        'warn',
        'Please do not use connectUser server side. connectUser impacts MAU and concurrent connection usage and thus your bill. If you have a valid use-case, add "allowServerSideConnect: true" to the client options to disable this warning.',
        { tags: ['connection', 'client'] },
      );
    }

    if (this.browser && !this.deviceId) {
      try {
        const encryptionStorage = new IndexedDBEncryptionStorage('', this.logger);
        this.deviceId = await encryptionStorage.getDeviceId();
        this.logger('info', `client:connectUser() - deviceId initialized: ${this.deviceId}`, {
          tags: ['connection', 'client', 'e2ee'],
        });
      } catch (err) {
        this.logger('warn', 'client:connectUser() - Failed to initialize deviceId from storage', {
          tags: ['connection', 'client', 'e2ee'],
          err,
        });
      }
    }

    // we generate the client id client side
    this.userID = connectionUser.id;

    // Initialize message storage for offline persistence (works for ALL channels, not just E2EE).
    // Uses the same IndexedDB database as encryptionManager (ermis_data_{userId})
    // so E2EE and standard messages share the same `messages` table.
    if (this.browser && !this.messageStorage) {
      try {
        const { IndexedDBEncryptionStorage } = await import('./encryption/storage');
        this.messageStorage = new IndexedDBEncryptionStorage(connectionUser.id, this.logger);
      } catch (err) {
        this.logger('warn', 'client:connectUser() - Failed to initialize messageStorage', {
          err,
          tags: ['storage'],
        });
      }
    }

    if (this.browser && !this.standardAttachmentUploadStorage && this.messageStorage) {
      try {
        // Reuse the shared ermis_data_{userId} DB — no separate DB created
        const dbProvider = () => this.messageStorage!.getDB();
        this.standardAttachmentUploadStorage = new StandardAttachmentUploadStorage(dbProvider, this.logger);
      } catch (err) {
        this.logger('warn', 'client:connectUser() - Failed to initialize standard attachment upload storage', {
          err,
          tags: ['storage', 'attachment'],
        });
      }
    }

    await this._hydrateUserCacheFromStorage();

    const setTokenPromise = this._setToken(connectionUser, connectionToken, options.refreshToken);
    this._setUser(connectionUser);
    this._upsertUser(
      {
        id: connectionUser.id,
        name: connectionUser?.name || connectionUser.id,
        avatar: connectionUser?.avatar || '',
      } as UserResponse<ErmisChatGenerics>,
      { updateReferences: false },
    );

    const wsPromise = this.openConnection();

    this.setUserPromise = Promise.all([setTokenPromise, wsPromise]).then(
      (result) => result[1], // We only return connection promise;
    );

    try {
      const result = await this.setUserPromise;
      // Automatically fetch full profile asynchronously and dispatch event
      this.queryUser(connectionUser.id)
        .then((fullProfile) => {
          const mergedUser = { ...(this.user || connectionUser), ...fullProfile } as UserResponse<ErmisChatGenerics>;
          this.user = mergedUser;
          this._upsertUser(mergedUser, { updateReferences: true });
          this.dispatchEvent({
            type: 'user.updated',
            me: this.user,
          } as unknown as Event<ErmisChatGenerics>);
        })
        .catch((err) => {
          this.logger('error', 'client:connectUser() - failed to fetch full user profile', { err });
        });

      await this._restorePendingStandardAttachmentUploads();
      return result;
    } catch (err) {
      this.disconnectUser();
      throw err;
    }
  };

  setUser = this.connectUser;

  _setToken = (
    user: UserResponse<ErmisChatGenerics>,
    userTokenOrProvider: string | null,
    refreshTokenOrProvider: RefreshTokenInput = this.options.refreshToken,
  ) => this.tokenManager.setTokenOrProvider(userTokenOrProvider, user, refreshTokenOrProvider);

  _setUser(user: UserResponse<ErmisChatGenerics>) {
    this.user = { ...user };
    this.userID = user.id;
  }

  private _getUserCache(): IndexedDBUserCache<ErmisChatGenerics> | null {
    if (!this.browser || !this.userID) return null;
    const namespace = `${this.projectId || this.userBaseURL || this.baseURL || 'default'}:${this.endUserApiMode}`;
    const key = `${namespace}:${this.userID}`;
    if (!this.userCache || this.userCacheKey !== key) {
      this.userCache = new IndexedDBUserCache<ErmisChatGenerics>(namespace, this.userID);
      this.userCacheKey = key;
    }
    return this.userCache;
  }

  private _persistUsersToCache(users: Array<UserResponse<ErmisChatGenerics>>): void {
    const cache = this._getUserCache();
    const validUsers = users.filter((user) => user?.id);
    if (!cache || validUsers.length === 0) return;

    cache.saveUsers(validUsers).catch((err) => {
      this.logger('warn', 'client:userCache - failed to persist users', { err });
    });
  }

  private _shouldRefreshUserReferences(
    existing: UserResponse<ErmisChatGenerics> | undefined,
    incoming: UserResponse<ErmisChatGenerics>,
  ): boolean {
    if (!existing) return true;
    return (
      existing.name !== incoming.name ||
      existing.avatar !== incoming.avatar ||
      existing.about_me !== incoming.about_me ||
      existing.email !== incoming.email ||
      existing.phone !== incoming.phone
    );
  }

  private _upsertUsers(
    users: Array<UserResponse<ErmisChatGenerics>>,
    options: { persist?: boolean; updateReferences?: boolean } = {},
  ): void {
    const { persist = true, updateReferences = true } = options;
    const validUsers = users.filter((user) => user?.id);
    if (validUsers.length === 0) return;
    const usersNeedingReferenceUpdate = updateReferences
      ? validUsers.filter((user) => this._shouldRefreshUserReferences(this.state.users[user.id], user))
      : [];

    this.state.updateUsers(validUsers);
    if (persist) {
      this._persistUsersToCache(validUsers);
    }

    for (const user of validUsers) {
      if (this.user?.id === user.id) {
        this.user = { ...this.user, ...user };
      }
    }

    for (const user of usersNeedingReferenceUpdate) {
      const updatedUser = this.state.users[user.id] || user;
      this._updateMemberWatcherReferences(updatedUser);
      this._updateUserMessageReferences(updatedUser);
    }

    if (usersNeedingReferenceUpdate.length > 0) {
      this.dispatchEvent({
        type: 'users.updated' as any,
        users: usersNeedingReferenceUpdate,
      } as any);
    }
  }

  private _upsertUser(
    user: UserResponse<ErmisChatGenerics>,
    options: { persist?: boolean; updateReferences?: boolean } = {},
  ): void {
    this._upsertUsers([user], options);
  }

  private async _hydrateUserCacheFromStorage(): Promise<void> {
    const cache = this._getUserCache();
    if (!cache) return;

    try {
      const cachedUsers = await cache.loadUsers();
      this._upsertUsers(cachedUsers, { persist: false, updateReferences: false });
    } catch (err) {
      this.logger('warn', 'client:userCache - failed to hydrate users from IndexedDB', { err });
    }
  }

  closeConnection = async (timeout?: number) => {
    if (this.cleaningIntervalRef != null) {
      clearInterval(this.cleaningIntervalRef);
      this.cleaningIntervalRef = undefined;
    }

    await this.wsConnection?.disconnect(timeout);
    return Promise.resolve();
  };

  openConnection = async () => {
    if (!this.userID) {
      throw Error('User is not set on client, use client.connectUser instead');
    }

    if (this.wsConnection?.isConnecting && this.wsPromise) {
      this.logger('info', 'client:openConnection() - connection already in progress', {
        tags: ['connection', 'client'],
      });
      return this.wsPromise;
    }

    if (this.wsConnection?.isHealthy) {
      this.logger('info', 'client:openConnection() - openConnection called twice, healthy connection already exists', {
        tags: ['connection', 'client'],
      });

      return Promise.resolve();
    }

    this.clientID = `${this.userID}--${randomId()}`;
    this.wsPromise = this.connect();
    this._startCleaning();
    return this.wsPromise;
  };

  _setupConnection = this.openConnection;

  /**
   * Gracefully disconnects the current user, terminates the WebSocket connection,
   * cleans up listeners, and resets the client's internal references.
   *
   * @param timeout - Optional timeout in milliseconds before forcing the disconnect.
   */
  disconnectUser = async (timeout?: number) => {
    this.logger('info', 'client:disconnect() - Disconnecting the client', {
      tags: ['connection', 'client'],
    });

    this._pausePendingStandardAttachmentUploads();

    if (this.standardAttachmentUploadStorage) {
      // DB lifecycle is managed by messageStorage (IndexedDBEncryptionStorage) — no close() needed
      this.standardAttachmentUploadStorage = undefined;
    }


    const encryptionMgr = this.encryptionManager;
    if (encryptionMgr && typeof encryptionMgr.destroy === 'function') {
      await encryptionMgr.destroy();
      this.encryptionManager = undefined;
    }

    if (this.messageStorage && typeof this.messageStorage.close === 'function') {
      await this.messageStorage.close();
    }

    if (this.userCache && typeof this.userCache.close === 'function') {
      await this.userCache.close();
    }

    this.deviceId = undefined;
    this.userCache = undefined;
    this.userCacheKey = undefined;

    // remove the user specific fields
    delete this.user;
    delete this.userID;

    const closePromise = this.closeConnection(timeout);

    for (const channel of Object.values(this.activeChannels)) {
      channel._disconnect();
    }
    // ensure we no longer return inactive channels
    this.activeChannels = {};
    // reset client state
    this.state = new ClientState();
    // reset token manager
    setTimeout(this.tokenManager.reset); // delay reseting to use token for disconnect calls

    // close the WS connection
    return closePromise;
  };

  disconnect = this.disconnectUser;

  /**
   * Attaches an event listener to the client connection.
   * Listeners can be scoped to specific event types (e.g. `message.new`) or listen to `all` events.
   *
   * @param callback - The handler invoked when the event is emitted.
   * @returns An object containing an `unsubscribe` method to detach the listener.
   */
  on(callback: EventHandler<ErmisChatGenerics>): { unsubscribe: () => void };
  /**
   * Attaches an event listener filtered by a specific event type.
   *
   * @param eventType - The specific event name to listen for (e.g., `'notification.message_new'`).
   * @param callback  - The handler invoked when the event is emitted.
   * @returns An object containing an `unsubscribe` method to detach the listener.
   */
  on(eventType: string, callback: EventHandler<ErmisChatGenerics>): { unsubscribe: () => void };
  on(
    callbackOrString: EventHandler<ErmisChatGenerics> | string,
    callbackOrNothing?: EventHandler<ErmisChatGenerics>,
  ): { unsubscribe: () => void } {
    const key = callbackOrNothing ? (callbackOrString as string) : 'all';
    const callback = callbackOrNothing ? callbackOrNothing : (callbackOrString as EventHandler<ErmisChatGenerics>);
    if (!(key in this.listeners)) {
      this.listeners[key] = [];
    }
    this.logger('info', `Attaching listener for ${key} event`, {
      tags: ['event', 'client'],
    });
    this.listeners[key].push(callback);
    return {
      unsubscribe: () => {
        this.logger('info', `Removing listener for ${key} event`, {
          tags: ['event', 'client'],
        });
        this.listeners[key] = this.listeners[key].filter((el) => el !== callback);
      },
    };
  }

  /**
   * Detaches a previously registered general event listener.
   * @param callback - The original handler reference to remove.
   */
  off(callback: EventHandler<ErmisChatGenerics>): void;
  /**
   * Detaches a previously registered event listener scoped to a specific event type.
   * @param eventType - The specific event name.
   * @param callback  - The original handler reference to remove.
   */
  off(eventType: string, callback: EventHandler<ErmisChatGenerics>): void;
  off(callbackOrString: EventHandler<ErmisChatGenerics> | string, callbackOrNothing?: EventHandler<ErmisChatGenerics>) {
    const key = callbackOrNothing ? (callbackOrString as string) : 'all';
    const callback = callbackOrNothing ? callbackOrNothing : (callbackOrString as EventHandler<ErmisChatGenerics>);
    if (!(key in this.listeners)) {
      this.listeners[key] = [];
    }

    this.logger('info', `Removing listener for ${key} event`, {
      tags: ['event', 'client'],
    });
    this.listeners[key] = this.listeners[key].filter((value) => value !== callback);
  }

  _logApiRequest(
    type: string,
    url: string,
    data: unknown,
    config: AxiosRequestConfig & {
      config?: AxiosRequestConfig & { maxBodyLength?: number };
    },
  ) {
    const loggedData =
      data && typeof data === 'object' && 'refresh_token' in data
        ? { ...(data as Record<string, unknown>), refresh_token: '[REDACTED]' }
        : data;
    this.logger(
      'info',
      `client: ${type} - Request - ${url}- ${JSON.stringify(loggedData)} - ${JSON.stringify(config.params)}`,
      {
        tags: ['api', 'api_request', 'client'],
        url,
        payload: loggedData,
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

  private _isTokenExpiredResponse(response?: AxiosResponse<unknown>) {
    if (!response) return false;
    const data = (response.data || {}) as Partial<APIErrorResponse>;
    const isExpiredCode = (code: unknown) => code === 'TOKEN_EXPIRED' || Number(code) === chatCodes.TOKEN_EXPIRED;
    return (
      response.status === 401 || response.status === 403 || isExpiredCode(data.code) || isExpiredCode(data.ermis_code)
    );
  }

  private async _doPublicEndUserRequest<T>(
    method: EndUserRequestMethod,
    url: string,
    data?: unknown,
    options: AxiosRequestConfig = {},
  ): Promise<T> {
    const requestConfig = this._enrichPublicAxiosOptions(options);
    let response: AxiosResponse<T>;
    this._logApiRequest(method, url, data, requestConfig);
    switch (method) {
      case 'get':
        response = await this.axiosInstance.get(url, requestConfig);
        break;
      case 'post':
        response = await this.axiosInstance.post(url, data, requestConfig);
        break;
      case 'postForm':
        response = await this.axiosInstance.postForm(url, data, requestConfig);
        break;
      case 'patch':
        response = await this.axiosInstance.patch(url, data, requestConfig);
        break;
      default:
        throw new Error(`Unsupported public end-user request method: ${method}`);
    }
    this._logApiResponse(method, url, response);
    return this.handleResponse(response);
  }

  doAxiosRequest = async <T>(
    type: string,
    url: string,
    data?: unknown,
    options: AxiosRequestConfig & {
      config?: AxiosRequestConfig & { maxBodyLength?: number };
      __tokenRefreshAttempted?: boolean;
    } = {},
  ): Promise<T> => {
    await this.tokenManager.tokenReady();

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
        if (this._isTokenExpiredResponse(e.response) && !options.__tokenRefreshAttempted) {
          await this.refreshAccessToken();
          const retryOptions = {
            ...options,
            __tokenRefreshAttempted: true,
            headers: { ...(options.headers || {}) },
          };
          delete (retryOptions.headers as Record<string, unknown>).Authorization;
          delete (retryOptions.headers as Record<string, unknown>).authorization;
          return this.doAxiosRequest<T>(type, url, data, retryOptions);
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

  sendFile(
    url: string,
    uri: string | NodeJS.ReadableStream | Buffer | File,
    name?: string,
    contentType?: string,
    user?: UserResponse<ErmisChatGenerics>,
  ) {
    const data = addFileToFormData(uri, name, contentType || 'multipart/form-data');
    if (user != null) data.append('user', JSON.stringify(user));

    return this.doAxiosRequest<SendFileAPIResponse>('postForm', url, data, {
      headers: data.getHeaders ? data.getHeaders() : {}, // node vs browser
      config: {
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
    });
  }

  /**
   * Downloads a media file as a Blob via the SDK's configured axiosInstance.
   * This avoids CORS issues that arise when using `fetch()` directly from the browser,
   * because axios is routed through the SDK's authenticated transport layer.
   *
   * @param url - The full URL of the media file to download.
   * @returns A Blob of the file content.
   */
  async downloadMedia(url: string): Promise<Blob> {
    const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to download media: ${response.statusText}`);
    }
    return await response.blob();
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

  dispatchEvent = (event: Event<ErmisChatGenerics>) => {
    if (!event.received_at) event.received_at = new Date();

    // If the event is channel.created or channel.topic.created, handle it asynchronously
    if (event.type === 'channel.created' || event.type === 'channel.topic.created') {
      this._handleChannelCreatedEvent(event).then(() => {
        this._afterDispatchEvent(event);
      });
    } else {
      const postListenerCallbacks = this._handleClientEvent(event);

      // channel event handlers
      const cid = event.cid;
      const channel =
        (cid ? this.activeChannels[cid] : undefined) ||
        (event.type === 'protocol' && cid?.startsWith('mls:') ? this.activeChannels[cid.slice(4)] : undefined);
      if (channel) {
        // _handleChannelEvent is async (e.g. message.new may await queryUser).
        // We MUST wait for it to finish mutating channel state BEFORE calling
        // listeners, otherwise React listeners (syncMessages) will read stale state.
        const result = channel._handleChannelEvent(event);
        if (result && typeof (result as any).then === 'function') {
          // Async path: defer listeners until state mutations complete
          (result as Promise<void>)
            .then(() => {
              this._callClientListeners(event);
              if (channel) {
                channel._callChannelListeners(event);
              }
              postListenerCallbacks.forEach((c) => c());
            })
            .catch((err) => {
              this.logger('error', 'client:_handleChannelEvent() failed', { err, event });
              // Even if state mutation failed partially, we must still notify listeners
              // otherwise UI gets permanently stuck and misses the event.
              this._callClientListeners(event);
              if (channel) {
                channel._callChannelListeners(event);
              }
              postListenerCallbacks.forEach((c) => c());
            });
          return;
        }
      }

      this._callClientListeners(event);

      if (channel) {
        channel._callChannelListeners(event);
      }

      postListenerCallbacks.forEach((c) => c());
    }
  };

  _afterDispatchEvent(event: Event<ErmisChatGenerics>) {
    const postListenerCallbacks = this._handleClientEvent(event);

    const cid = event.cid;
    const channel =
      (cid ? this.activeChannels[cid] : undefined) ||
      (event.type === 'protocol' && cid?.startsWith('mls:') ? this.activeChannels[cid.slice(4)] : undefined);
    if (channel) {
      const result = channel._handleChannelEvent(event);
      if (result && typeof (result as any).then === 'function') {
        (result as Promise<void>).then(() => {
          this._callClientListeners(event);
          if (channel) {
            channel._callChannelListeners(event);
          }
          postListenerCallbacks.forEach((c) => c());
        });
        return;
      }
    }

    this._callClientListeners(event);

    if (channel) {
      channel._callChannelListeners(event);
    }

    postListenerCallbacks.forEach((c) => c());
  }

  private async _handleChannelCreatedEvent(event: Event<ErmisChatGenerics>) {
    const members = event.channel?.members || [];
    // Ensure all members' user info are loaded in state.users
    await ensureMembersUserInfoLoaded(this, members);

    // Get the latest users after updating
    const updatedUsers = Object.values(this.state.users);

    const enrichedMembers = enrichWithUserInfo(members, updatedUsers);
    const channelName =
      event.channel_type === 'messaging'
        ? getDirectChannelName(enrichedMembers, this.userID || '')
        : event.channel?.name;
    const channel = {
      ...event.channel,
      members: enrichedMembers,
      name: channelName,
    };
    const channelState: any = {
      channel,
      members: enrichedMembers,
      messages: [],
      pinned_messages: [],
    };
    const c = this.channel(event.channel_type || '', event.channel_id || '');
    c.data = channel;
    c._initializeState(channelState, 'latest');
  }

  handleEvent = (messageEvent: WebSocket.MessageEvent) => {
    // dispatch the event to the channel listeners
    const jsonString = messageEvent.data as string;
    const event = normalizeE2eeEventBytes(JSON.parse(jsonString) as Event<ErmisChatGenerics>);
    this.dispatchEvent(event);
  };

  _updateMemberWatcherReferences = (user: UserResponse<ErmisChatGenerics>) => {
    // Iterate through all active channels to ensure we update members even if they haven't sent messages yet
    Object.values(this.activeChannels).forEach((channel) => {
      if (channel?.state) {
        let hasChange = false;
        if (channel.state.members[user.id]) {
          channel.state.members = {
            ...channel.state.members,
            [user.id]: {
              ...channel.state.members[user.id],
              user,
            },
          };
          hasChange = true;

          // Update display name/image for 1-1 Messaging Channels
          if (channel.data?.type === 'messaging') {
            const members = Object.values(channel.state.members);
            if (members.length === 2) {
              const otherMember = members.find((m) => m.user?.id !== this.userID);
              if (otherMember && otherMember.user?.id === user.id) {
                channel.data.name = user.name || user.id;
                channel.data.image = user.avatar || '';
              }
            }
          }
        }
        if (channel.state.watchers[user.id]) {
          channel.state.watchers = {
            ...channel.state.watchers,
            [user.id]: user,
          };
          hasChange = true;
        }
        if (channel.state.read[user.id]) {
          channel.state.read = {
            ...channel.state.read,
            [user.id]: {
              ...channel.state.read[user.id],
              user,
            },
          };
          hasChange = true;
        }

        if (hasChange) {
          // Trigger channel update for Sidebar and Header
          channel._callChannelListeners({
            type: 'channel.updated',
            channel: channel.data,
            cid: channel.cid,
          } as any);

          // Trigger member update specifically for Member List components
          if (channel.state.members[user.id]) {
            channel._callChannelListeners({
              type: 'member.updated',
              member: channel.state.members[user.id],
              cid: channel.cid,
            } as any);
          }

          // Trigger general user update at channel level
          channel._callChannelListeners({
            type: 'user.updated',
            user: user,
            cid: channel.cid,
          } as any);
        }
      }
    });
  };

  _updateUserReferences = this._updateMemberWatcherReferences;

  _updateUserMessageReferences = (user: UserResponse<ErmisChatGenerics>) => {
    const refMap = this.state.userChannelReferences[user.id] || {};

    for (const channelID in refMap) {
      const channel = this.activeChannels[channelID];
      if (!channel) continue;

      const state = channel.state;

      /** Update the message objects from this user in the state. */
      state?.updateUserMessages(user);

      // Trigger re-render for message list components
      channel._callChannelListeners({
        type: 'channel.updated',
        channel: channel.data,
        cid: channel.cid,
      } as any);

      // Force MessageList refresh by dispatching an update for the last message
      const lastMessage = state?.messages[state.messages.length - 1];
      if (lastMessage) {
        channel._callChannelListeners({
          type: 'message.updated',
          message: lastMessage,
          cid: channel.cid,
        } as any);
      }
    }
  };
  private _restorePendingStandardAttachmentUploads = async () => {
    const storage = this.standardAttachmentUploadStorage;
    if (!storage) return;
    try {
      const records = await storage.list();
      for (const record of records) {
        if (!record.channel_type || !record.channel_id || !record.message_id) {
          await storage.delete(record.message_id).catch(() => undefined);
          continue;
        }
        const channel = this.channel(record.channel_type, record.channel_id);
        await channel.restorePendingStandardAttachmentUpload(record);
      }
    } catch (error) {
      this.logger('warn', 'Failed to restore pending standard attachment uploads', {
        err: error,
        tags: ['storage', 'attachment'],
      });
    }
  };

  _resumePendingStandardAttachmentUploads = async () => {
    await Promise.all(
      Object.values(this.activeChannels).map((channel) => channel.resumePendingStandardAttachmentUploads()),
    );
  };

  _pausePendingStandardAttachmentUploads = () => {
    let paused = 0;
    Object.values(this.activeChannels).forEach((channel) => {
      paused += channel.pausePendingStandardAttachmentUploads();
    });
    return paused;
  };

  _deleteUserMessageReference = (user: UserResponse<ErmisChatGenerics>, hardDelete = false) => {
    const refMap = this.state.userChannelReferences[user.id] || {};

    for (const channelID in refMap) {
      const channel = this.activeChannels[channelID];
      const state = channel.state;

      /** deleted the messages from this user. */
      state?.deleteUserMessages(user, hardDelete);
    }
  };

  _abortPendingAttachmentUploads = () => {
    Object.values(this.activeChannels).forEach((channel) => {
      channel.abortPendingAttachmentUploads();
    });
  };

  _handleClientEvent(event: Event<ErmisChatGenerics>) {
    const client = this;
    const postListenerCallbacks = [];
    this.logger('info', `client:_handleClientEvent - Received event of type { ${event.type} }`, {
      tags: ['event', 'client'],
      event,
    });

    if (event.type === 'health.check' && typeof event.project_id === 'string' && event.project_id) {
      this._updateProjectID(event.project_id);
    }

    if (event.type === 'health.check' && event.me) {
      const remaining = (event.me as any).key_packages_remaining;
      if (typeof remaining === 'number') {
        this.latestKeyPackagesRemaining = remaining;
      }
      if (this.encryptionManager?.initialized && typeof remaining === 'number') {
        this.encryptionManager.ensureKeyPackages(remaining).catch((err: unknown) => {
          this.logger('warn', '[Encryption] Failed to top up key packages', { err });
        });
      }
    }

    if (event.type === 'connection.changed' && event.online === false) {
      this._abortPendingAttachmentUploads();
    } else if (event.type === 'connection.changed' && event.online === true) {
      void this._resumePendingStandardAttachmentUploads().catch((error) => {
        this.logger('warn', 'Failed to resume standard attachment uploads', { err: error });
      });
      void this.encryptionManager?.resumePendingE2eeSends().catch((error: unknown) => {
        this.logger('warn', 'Failed to resume E2EE attachment uploads', { err: error });
      });
    }

    if ((event.type === 'channel.deleted' || event.type === 'notification.channel_deleted') && event.cid) {
      client.state.deleteAllChannelReference(event.cid);
      this.activeChannels[event.cid]?.state.clearMessages();
      this.activeChannels[event.cid]?.state.resetSyncState();
      this.activeChannels[event.cid]?._disconnect();
      this._clearChannelLocalStorage(event.cid).catch((err) => {
        this.logger('warn', 'client:_handleClientEvent() - Failed to clear deleted channel storage', {
          err,
          cid: event.cid,
        });
      });

      postListenerCallbacks.push(() => {
        if (!event.cid) return;

        delete this.activeChannels[event.cid];
      });

      for (const channel of Object.values(this.activeChannels)) {
        if (channel.type === 'team' && channel.state.topics?.some((t) => t.cid === event.cid)) {
          // Remove the topic with matching cid from the topics array
          channel.state.topics = channel.state.topics.filter((t) => t.cid !== event.cid);
        }
      }
    }
    if (event.type === 'notification.invite_rejected') {
      if (event.member?.user_id === this.userID && event.cid) {
        if (event.mls_enabled && this.encryptionManager?.initialized) {
          const rejectTimestamp = event.created_at || event.createdAt || event.message?.created_at || Date.now();
          this.encryptionManager.leaveGroup(event.cid, rejectTimestamp);
          if (Array.isArray(event.topic_cids)) {
            for (const topicCid of event.topic_cids) {
              if (this.encryptionManager.ownsE2eeGroup(topicCid)) {
                this.encryptionManager.leaveGroup(topicCid, rejectTimestamp);
              }
            }
          }
        }

        client.state.deleteAllChannelReference(event.cid);
        this.activeChannels[event.cid]?.state.clearMessages();
        this.activeChannels[event.cid]?.state.resetSyncState();
        this.activeChannels[event.cid]?._disconnect();
        this._clearChannelLocalStorage(event.cid).catch((err) => {
          this.logger('warn', 'client:_handleClientEvent() - Failed to clear rejected channel storage', {
            err,
            cid: event.cid,
          });
        });

        postListenerCallbacks.push(() => {
          if (!event.cid) return;

          delete this.activeChannels[event.cid];
        });
      }
    }
    if (event.type === 'notification.invite_accepted') {
      // NOTE: Re-watching team channels to load topics is handled by the React UI layer
      // (useChannelListUpdates) which also triggers necessary React re-renders.
    }

    if (event.type === 'member.added') {
      if (event.member?.user_id === this.userID) {
        const c = this.channel(event.channel_type || '', event.channel_id || '');
        // Gọi watch để lấy đầy đủ thông tin channel từ server
        c.watch().catch((err) => {
          this.logger('error', 'Failed to watch channel after member.added', { err, event });
        });
      }
    }

    if (event.type === 'message.new' && event.channel_type === 'topic') {
      postListenerCallbacks.push(() => {
        const parentCid = event.parent_cid || event.channel?.parent_cid;
        if (parentCid && this.activeChannels[parentCid]) {
          const parentChannel = this.activeChannels[parentCid];
          if (parentChannel.state.topics) {
            parentChannel.state.topics.sort((a, b) => {
              const aLatest = a.state?.latestMessages?.[a.state.latestMessages.length - 1]?.created_at;
              const bLatest = b.state?.latestMessages?.[b.state.latestMessages.length - 1]?.created_at;
              const aTime = aLatest ? new Date(aLatest).getTime() : 0;
              const bTime = bLatest ? new Date(bLatest).getTime() : 0;
              return bTime - aTime;
            });
            parentChannel._callChannelListeners({
              ...event,
              type: 'channel.updated',
              channel: parentChannel.data,
            } as any);
          }
        }
      });
    }
    if (event.type === 'channel.topic.updated') {
      postListenerCallbacks.push(() => {
        const parentCid = event.parent_cid || event.channel?.parent_cid;
        if (parentCid && this.activeChannels[parentCid]) {
          const parentChannel = this.activeChannels[parentCid];
          if (parentChannel.state?.topics && event.channel) {
            const topicIndex = parentChannel.state.topics.findIndex(
              (t: any) => t.cid === event.cid || t.channel?.cid === event.cid,
            );
            if (topicIndex !== -1) {
              const t = parentChannel.state.topics[topicIndex] as any;
              if (t.data) {
                t.data = { ...t.data, ...event.channel };
              } else if (t.channel) {
                t.channel = { ...t.channel, ...event.channel };
              } else {
                Object.assign(t, event.channel);
              }
            }
            parentChannel._callChannelListeners({
              ...event,
              type: 'channel.updated',
              channel: parentChannel.data,
            } as any);
          }
        }

        if (event.cid && this.activeChannels[event.cid]) {
          const topicChannel = this.activeChannels[event.cid];
          if (event.channel) {
            topicChannel.data = { ...topicChannel.data, ...event.channel };
            topicChannel._callChannelListeners({
              ...event,
              type: 'channel.updated',
              channel: topicChannel.data,
            } as any);
          }
        }
      });
    }

    if (event.type === 'channel.topic.closed' || event.type === 'channel.topic.reopen') {
      postListenerCallbacks.push(() => {
        const isClosed = event.type === 'channel.topic.closed';
        const parentCid = event.parent_cid;
        if (parentCid && this.activeChannels[parentCid]) {
          const parentChannel = this.activeChannels[parentCid];
          if (parentChannel.state?.topics) {
            const topicIndex = parentChannel.state.topics.findIndex(
              (t: any) => t.cid === event.cid || t.channel?.cid === event.cid,
            );
            if (topicIndex !== -1) {
              const t = parentChannel.state.topics[topicIndex] as any;
              if (t.data) t.data.is_closed_topic = isClosed;
              else if (t.channel) t.channel.is_closed_topic = isClosed;
              else t.is_closed_topic = isClosed;
            }
            parentChannel._callChannelListeners({
              ...event,
              type: 'channel.updated',
              channel: parentChannel.data,
            } as any);
          }
        }

        if (event.cid && this.activeChannels[event.cid]) {
          const topicChannel = this.activeChannels[event.cid];
          if (topicChannel.data) {
            topicChannel.data.is_closed_topic = isClosed;
          }
          topicChannel._callChannelListeners({ ...event, type: 'channel.updated', channel: topicChannel.data } as any);
        }
      });
    }

    if (event.type === 'connection.recovered') {
      postListenerCallbacks.push(() => {
        // Auto-resend offline failed messages
        Object.values(this.activeChannels).forEach((channel) => {
          if (!channel.state?.messages) return;
          const offlineFailedMsgs = channel.state.messages.filter(
            (m) =>
              m.status === 'failed_offline' &&
              m.user?.id === this.userID &&
              (!m.attachments || m.attachments.length === 0),
          );
          offlineFailedMsgs.forEach((msg) => {
            if (msg.id) {
              channel.retryMessage(msg.id).catch((err) => {
                this.logger('error', `Failed to auto-resend offline message ${msg.id}`, {
                  tags: ['offline', 'retry'],
                  err,
                });
              });
            }
          });
        });
      });
    }

    return postListenerCallbacks;
  }

  _callClientListeners = (event: Event<ErmisChatGenerics>) => {
    const client = this;
    // gather and call the listeners
    const listeners: Array<(event: Event<ErmisChatGenerics>) => void> = [];
    if (client.listeners.all) {
      listeners.push(...client.listeners.all);
    }
    if (client.listeners[event.type]) {
      listeners.push(...client.listeners[event.type]);
    }

    // call the event and send it to the listeners
    for (const listener of listeners) {
      listener(event);
    }
  };

  recoverState = async () => {
    this.logger('info', 'client:recoverState() - Start of recoverState', {
      tags: ['connection'],
    });

    // Try Event Sourcing sync first (faster, sequence-based)
    const cids = Object.keys(this.activeChannels);
    if (cids.length && this.recoverStateOnReconnect) {
      try {
        await this.performSync();
        this.logger('info', 'client:recoverState() - Event Sourcing sync completed', {
          tags: ['connection', 'client', 'sync'],
        });
        this.dispatchEvent({
          type: 'connection.recovered',
        } as Event<ErmisChatGenerics>);
      } catch (syncErr) {
        this.logger('warn', 'client:recoverState() - Event sync failed, falling back to queryChannels', {
          err: syncErr,
          tags: ['connection', 'client', 'sync'],
        });

        // Fallback to legacy queryChannels recovery
        this.logger('info', `client:recoverState() - Start the querying of ${cids.length} channels`, {
          tags: ['connection', 'client'],
        });

        const {
          filter = { type: ['messaging', 'team', 'meeting'] } as ChannelFilters,
          sort = [],
          options = { message_limit: 1 },
        } = this.options.recoveryConfig || {};
        await this.queryChannels(filter, sort, options);

        this.logger('info', 'client:recoverState() - Querying channels finished', { tags: ['connection', 'client'] });
        this.dispatchEvent({
          type: 'connection.recovered',
        } as Event<ErmisChatGenerics>);
      }
    } else {
      this.dispatchEvent({
        type: 'connection.recovered',
      } as Event<ErmisChatGenerics>);
    }

    this.wsPromise = Promise.resolve();
    this.setUserPromise = Promise.resolve();
  };

  async connect() {
    if (!this.userID || !this.user) {
      throw Error('Call connectUser before starting the connection');
    }
    if (!this.wsBaseURL) {
      throw Error('Websocket base url not set');
    }
    if (!this.clientID) {
      throw Error('clientID is not set');
    }

    // if (!this.wsConnection && (this.options.warmUp || this.options.enableInsights)) {
    //   this._sayHi();
    // }
    // The StableWSConnection handles all the reconnection logic.
    if (this.options.wsConnection && this.node) {
      // Intentionally avoiding adding ts generics on wsConnection in options since its only useful for unit test purpose.
      (this.options.wsConnection as unknown as StableWSConnection<ErmisChatGenerics>).setClient(this);
      this.wsConnection = this.options.wsConnection as unknown as StableWSConnection<ErmisChatGenerics>;
    } else {
      this.wsConnection = new StableWSConnection<ErmisChatGenerics>({
        client: this,
      });
    }

    try {
      return await this.wsConnection.connect(this.defaultWSTimeout);
    } catch (err: any) {
      throw err;
    }
  }
  public async connectToSSE(onCallBack?: (data: any) => void): Promise<void> {
    const sseUrl = this.endUserApi.getSseUrl();
    if (this.eventSource) {
      this.logger('info', 'client:connectToSSE() - SSE connection already established', {});
      return;
    }
    let token = this._getToken();
    if (!token?.startsWith('Bearer ')) token = `Bearer ${token}`;
    this.eventSource = new EventSourcePolyfill(sseUrl, {
      headers: { method: 'GET', Authorization: token },
      heartbeatTimeout: 60000,
    });
    this.eventSource.onopen = () => {
      this.logger('info', 'client:connectToSSE() - SSE connection established', {});
    };
    this.eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type !== 'AccountUserChainProjects') return;
      const userInfo = {
        id: data.id,
        name: data.name,
        avatar: data.avatar,
        about_me: data.about_me,
        project_id: data.project_id,
      } as UserResponse<ErmisChatGenerics>;
      if (this.user?.id === userInfo.id) this.user = { ...this.user, ...userInfo };
      this._upsertUser(userInfo);
      onCallBack?.(data);
      this.dispatchEvent({
        type: 'user.updated',
        user: userInfo,
        me: this.user?.id === userInfo.id ? this.user : undefined,
      } as Event<ErmisChatGenerics>);
    };
    this.eventSource.onerror = (event: any) => {
      if (event.status === 401) {
        void this.disconnectFromSSE();
        return;
      }
      if (
        this.eventSource?.readyState === EventSourcePolyfill.CLOSED ||
        this.eventSource?.readyState === EventSourcePolyfill.CONNECTING
      ) {
        this.eventSource.close();
        this.eventSource = null;
        setTimeout(() => void this.connectToSSE(onCallBack), 3000);
      }
    };
  }
  public async disconnectFromSSE(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.logger('info', 'client:disconnectFromSSE() - SSE connection closed', {});
    } else {
      this.logger('info', 'client:disconnectFromSSE() - SSE connection already closed', {});
    }
  }

  async queryUsers(page_size = 100, page = 1): Promise<UsersResponse<ErmisChatGenerics>> {
    await this.wsPromise;
    const userIDAtRequest = this.userID;
    const response = await this.endUserApi.queryUsers(page_size, page);
    if (userIDAtRequest && this.userID === userIDAtRequest) this._upsertUsers(response.data);
    return response;
  }

  async syncUserCache(page_size = 10000, page = 1): Promise<UsersResponse<ErmisChatGenerics>> {
    return this.queryUsers(page_size, page);
  }

  async queryUser(user_id: string): Promise<UserResponse<ErmisChatGenerics>> {
    const userIDAtRequest = this.userID;

    const userResponse = await this.endUserApi.queryUser(user_id);

    if (userIDAtRequest && this.userID === userIDAtRequest) {
      this._upsertUser(userResponse);
    }
    return userResponse;
  }

  async getBatchUsers(users: string[], _page?: number, _page_size?: number) {
    const userIDAtRequest = this.userID;
    const allUsers = await this.endUserApi.getBatchUsers(users, _page || 1, _page_size || 10000);

    if (userIDAtRequest && this.userID === userIDAtRequest) {
      this._upsertUsers(allUsers);
    }

    return allUsers;
  }

  async searchUsers(query: string, limit?: number): Promise<UsersResponse<ErmisChatGenerics>>;
  async searchUsers(page: number, page_size: number, name?: string): Promise<UsersResponse<ErmisChatGenerics>>;
  async searchUsers(
    queryOrPage: string | number,
    limitOrPageSize = 20,
    legacyName?: string,
  ): Promise<UsersResponse<ErmisChatGenerics>> {
    const usersResponse = await this.endUserApi.searchUsers({
      query: (typeof queryOrPage === 'string' ? queryOrPage : legacyName || '').trim(),
      page: typeof queryOrPage === 'number' ? queryOrPage : 1,
      pageSize: Number(limitOrPageSize) || 20,
    });

    this._upsertUsers(usersResponse.data);

    return usersResponse;
  }

  async queryContacts(): Promise<ContactResult> {
    const contactResponse = await this.post<ContactResponse>(this.baseURL + '/contacts/list', this._withProjectId({}));
    const contactGroups = this.projectId
      ? contactResponse.project_id_user_ids[this.projectId]
      : Object.values(contactResponse.project_id_user_ids).flat();
    const userIds = contactGroups || [];
    const contact_users: UserResponse<ErmisChatGenerics>[] = [];
    const block_users: UserResponse<ErmisChatGenerics>[] = [];

    userIds.forEach((contact: Contact) => {
      const userID = contact.other_id;
      const state_user = this.state.users[userID];
      const user = state_user ? state_user : { id: userID };
      switch (contact.relation_status) {
        case 'blocked':
          block_users.push(user);
          break;
        case 'normal':
          contact_users.push(user);
          break;
        default:
      }
    });

    return {
      contact_users,
      block_users,
    };
  }

  _updateProjectID(project_id: string) {
    this.projectId = project_id;
  }

  /**
   * Uploads a new avatar image for the current user.
   * The user's avatar URL is automatically updated in both the client and the local state.
   *
   * @param file - The image file to upload.
   * @returns The response containing the new avatar URL.
   */
  async uploadAvatar(file: File) {
    const response = await this.endUserApi.uploadAvatar(file);
    if (this.user) {
      this.user = { ...this.user, ...response };
      this._upsertUser(this.user);

      this.dispatchEvent({
        type: 'user.updated',
        me: this.user,
      } as unknown as Event<ErmisChatGenerics>);
    }

    return response;
  }
  async updateProfile(updates: Partial<UserResponse<ErmisChatGenerics>>) {
    const response = await this.endUserApi.updateProfile(updates);
    this.user = response;
    this._upsertUser(response);

    if (this.user) {
      this.dispatchEvent({
        type: 'user.updated',
        me: this.user,
      } as unknown as Event<ErmisChatGenerics>);
    }

    return response;
  }

  /**
   * Queries the API for a list of channels based on provided search filters and sort conditions.
   * Also hydrates these channels into the local SDK state memory.
   *
   * @param filterConditions - Specific criteria to filter channels (e.g. `{ type: 'messaging', members: { $in: ['user1'] } }`).
   * @param sort             - The sorting hierarchy applied to the channel results.
   * @param options          - Pagination and message limit parameters.
   * @param stateOptions     - Defines whether to skip state initialization or offline usage.
   * @returns                  An array of hydrated and locally manageable `Channel` objects.
   */
  async queryChannels(
    filterConditions: ChannelFilters,
    sort: ChannelSort = [],
    options: { message_limit?: number } = {},
    stateOptions: ChannelStateOptions = {},
  ) {
    // Make sure we wait for the connect promise if there is a pending one
    await this.wsPromise;

    // Return a list of channels
    const payload = {
      filter_conditions: this._withProjectId({ ...filterConditions }),
      sort,
      ...options,
    };

    const data = await this.post<QueryChannelsAPIResponse<ErmisChatGenerics>>(this.baseURL + '/channels', payload);

    // Sort channels by latest message created_at (including topics if present)
    data.channels.sort((a, b) => {
      // Get latest message created_at in channel a
      let aLatest = getLatestCreatedAt(a.messages);

      // If channel a has topics, check messages in topics
      if (a.channel.type === 'team' && Array.isArray(a.topics)) {
        for (const topic of a.topics) {
          aLatest = Math.max(aLatest, getLatestCreatedAt(topic.messages));
        }
      }

      // Get latest message created_at in channel b
      let bLatest = getLatestCreatedAt(b.messages);

      // If channel b has topics, check messages in topics
      if (b.channel.type === 'team' && Array.isArray(b.topics)) {
        for (const topic of b.topics) {
          bLatest = Math.max(bLatest, getLatestCreatedAt(topic.messages));
        }
      }

      // Descending order (newest first)
      return bLatest - aLatest;
    });

    const memberIds =
      Array.from(
        new Set(data.channels.flatMap((c) => (c.channel.members || []).map((member: any) => member.user.id))),
      ) || [];

    if (!filterConditions.parent_cid) {
      const dummyMembers = memberIds.map((id) => ({ user: { id } }));
      await ensureMembersUserInfoLoaded(this as any, dummyMembers);
    }
    const membersInfo = Object.values(this.state.users);
    data.channels.forEach((c) => {
      c.channel.members = enrichWithUserInfo(c.channel.members, membersInfo);
      c.messages = enrichWithUserInfo(c.messages, membersInfo);
      c.read = enrichWithUserInfo(c.read || [], membersInfo);
      c.channel.name =
        c.channel.type === 'messaging' ? getDirectChannelName(c.channel.members, this.userID || '') : c.channel.name;
      c.channel.image =
        c.channel.type === 'messaging' ? getDirectChannelImage(c.channel.members, this.userID || '') : c.channel.image;

      if (c.channel.type === 'team' && Array.isArray(c.topics)) {
        c.topics.sort((a, b) => {
          const aLatest = getLatestCreatedAt(a.messages);
          const bLatest = getLatestCreatedAt(b.messages);
          return bLatest - aLatest;
        });
      }

      if (c.pinned_messages) {
        c.pinned_messages = enrichWithUserInfo(c.pinned_messages || [], membersInfo);
      }
    });

    // Ensure all channels are instantiated in activeChannels first.
    // This allows restoreSyncState() to populate lastMsgSeqBeforeChatDeleted
    // BEFORE hydrateChannels() runs _initializeState() and addMessagesSorted().
    data.channels.forEach((channelState) => {
      this.channel(channelState.channel.type, channelState.channel.id);
    });

    // Restore sync states from IndexedDB into the newly instantiated channels
    // so that lastMsgSeqBeforeChatDeleted is available for filtering messages below.
    await this.restoreSyncState();

    // A query snapshot can carry a newer clear-history boundary than IndexedDB.
    // Apply it and finish deleting stale local messages before hydration/events.
    const applyHistoryBoundary = async (channelState: ChannelAPIResponse<ErmisChatGenerics>): Promise<void> => {
      await this.channel(channelState.channel.type, channelState.channel.id)._applyQueryHistoryBoundary(channelState);
      await Promise.all((channelState.topics || []).map(applyHistoryBoundary));
    };
    await Promise.all(data.channels.map(applyHistoryBoundary));

    // Hydrate E2EE messages from local cache BEFORE initializing state.
    // Without this, encrypted API messages overwrite decrypted local messages,
    // causing the UI to show "encrypted message" until the user switches channels.
    const e2eeStorage = this.encryptionManager?.storage || this.messageStorage;
    if (e2eeStorage) {
      await Promise.all(
        data.channels.map(async (channelState) => {
          const isE2ee = (channelState.channel as any)?.mls_enabled === true;
          if (!isE2ee || !channelState.messages?.length) return;

          // Get or create the channel instance (reused by hydrateChannels below)
          const ch = this.channel(channelState.channel.type, channelState.channel.id);
          channelState.messages = await ch._hydrateE2eeMessagesFromLocalCache(
            channelState.messages,
            channelState.channel,
          );
          if (channelState.pinned_messages?.length) {
            channelState.pinned_messages = await ch._hydrateE2eeMessagesFromLocalCache(
              channelState.pinned_messages,
              channelState.channel,
            );
          }
        }),
      );
    }

    const { channels, userIds } = this.hydrateChannels(data.channels, stateOptions);
    //   await this.getBatchUsers(userIds);
    // }

    await this._persistSyncState();

    this.dispatchEvent({
      type: 'channels.queried',
    } as unknown as Event<ErmisChatGenerics>);

    return channels;
  }

  hydrateChannels(
    channelsFromApi: ChannelAPIResponse<ErmisChatGenerics>[] = [],
    stateOptions: ChannelStateOptions = {},
  ) {
    const { skipInitialization, offlineMode = false } = stateOptions;

    const channels: Channel<ErmisChatGenerics>[] = [];
    const userIds: string[] = [];
    for (const channelState of channelsFromApi) {
      const c = this.channel(channelState.channel.type, channelState.channel.id);
      c.data = { ...channelState.channel, is_pinned: channelState.is_pinned || false };
      c.offlineMode = offlineMode;
      c.initialized = !offlineMode;

      if (skipInitialization === undefined) {
        c._initializeState(channelState, 'latest', (id) => {
          if (!userIds.includes(id)) {
            userIds.push(id);
          }
        });
      } else if (!skipInitialization.includes(channelState.channel.id)) {
        c.state.clearMessages();
        c._initializeState(channelState, 'latest', (id) => {
          if (!userIds.includes(id)) {
            userIds.push(id);
          }
        });
      }

      channels.push(c);
    }

    // const sortedChannels = channels.sort((a: any, b: any) => {
    //   const aTime = a.state.last_message_at
    //     ? new Date(a.state.last_message_at).getTime()
    //     : a.data.created_at
    //     ? new Date(a.data.created_at).getTime()
    //     : 0;
    //   const bTime = b.state.last_message_at
    //     ? new Date(b.state.last_message_at).getTime()
    //     : b.data.created_at
    //     ? new Date(b.data.created_at).getTime()
    //     : 0;
    //   return bTime - aTime; // Descending order
    // });

    // ensure we have the users for all the channels we just added

    return { channels, userIds };
  }

  async searchPublicChannel(search_term: string, offset = 0, limit = 25) {
    const project_id = this._requireProjectId('searchPublicChannel');

    return await this.post<APIResponse>(this.baseURL + `/channels/public/search`, {
      project_id,
      search_term,
      limit: limit,
      offset: offset,
    });
  }

  async pinChannel(channelType: string, channelId: string) {
    return await this.post<APIResponse>(this.baseURL + `/channels/${channelType}/${channelId}/pin`);
  }

  async unpinChannel(channelType: string, channelId: string) {
    return await this.post<APIResponse>(this.baseURL + `/channels/${channelType}/${channelId}/unpin`);
  }

  // ─── Event Sourcing Sync API ─────────────────────────────────────────────────

  /**
   * POST /sync — Sync events for multiple channels at once.
   * This is the primary API for offline catch-up (cold start / background→foreground).
   * @see intergration-guide.md Section 3.2
   */
  async globalSync(request: GlobalSyncRequest): Promise<GlobalSyncResponse<ErmisChatGenerics>> {
    return await this.post<GlobalSyncResponse<ErmisChatGenerics>>(this.baseURL + '/sync', request);
  }

  /**
   * Perform a full sync flow for all active channels.
   * Features:
   * - Debounce: only one sync runs at a time; concurrent calls await the same promise.
   * - Selective sync: only syncs channels that have an initialized state.
   * - Removed cursor persistence: incrementally syncs removed channels across calls.
   * - CID-missing detection: channels in cursors but absent from response are treated as removed.
   * - E2EE delegation: E2EE channels are delegated to encryptionManager if available.
   * - User info enrichment: messages from sync events are enriched with cached user data.
   * @see intergration-guide.md Section 4.1 (Cold Start) & Section 4.3 (Background→Foreground)
   */
  async performSync(force = false): Promise<void> {
    // Throttle: don't sync if we just synced successfully within the last 2500ms, unless forced
    if (!force && this._lastSyncCompletedAt && Date.now() - this._lastSyncCompletedAt < 2500) {
      this.logger('info', 'client:performSync() - Throttled: Sync completed recently, skipping', {
        tags: ['sync'],
      });
      return Promise.resolve();
    }

    // Debounce: if a sync is already running, return the same promise
    if (this._syncInProgress && this._syncPromise) {
      this.logger('info', 'client:performSync() - Sync already in progress, reusing promise', {
        tags: ['sync'],
      });
      return this._syncPromise;
    }

    this._syncInProgress = true;

    // Start E2EE sync early to block websocket decryptions during sync
    if (this.encryptionManager?.initialized) {
      this.encryptionManager.markSyncStart();
    }

    // Run both None-E2E and E2E syncs concurrently
    this._syncPromise = Promise.all([
      this._performSyncInternal(),
      this.encryptionManager?.initialized ? this.encryptionManager.sync() : Promise.resolve(),
    ])
      .then(() => {
        this._lastSyncCompletedAt = Date.now();
      })
      .finally(() => {
        this._syncInProgress = false;
        this._syncPromise = null;
      }) as unknown as Promise<void>;

    return this._syncPromise;
  }

  private async _clearChannelLocalStorage(cid: string): Promise<void> {
    const storages = Array.from(new Set([this.messageStorage, this.encryptionManager?.storage].filter(Boolean)));
    await Promise.allSettled(
      storages.flatMap((storage: any) =>
        [storage.clearMessages?.(cid), storage.deleteSyncState?.(cid), storage.deleteChannelRepairState?.(cid)].filter(
          Boolean,
        ),
      ),
    );
  }

  private async _removeChannelLocally(
    cid: string,
    removedEvent?: { channel_id?: string; channel_type?: string; removal_type?: string },
  ): Promise<void> {
    const channel = this.activeChannels[cid];
    const [fallbackType, fallbackId] = cid.split(':');
    const channelType = removedEvent?.channel_type || channel?.type || fallbackType;
    const channelId = removedEvent?.channel_id || channel?.id || fallbackId;

    this.logger('info', `client:removeChannelLocally() - Removing channel ${cid}`, {
      tags: ['sync'],
      removal_type: removedEvent?.removal_type,
    });

    this.state.deleteAllChannelReference(cid);
    if (channel) {
      channel.state.clearMessages();
      channel.state.resetSyncState();
      channel._disconnect();
    }
    await this._clearChannelLocalStorage(cid);
    delete this.activeChannels[cid];

    this.dispatchEvent({
      type: 'channel.deleted',
      cid,
      channel_id: channelId,
      channel_type: channelType,
    } as Event<ErmisChatGenerics>);
  }

  /**
   * Internal sync implementation. Should only be called via performSync().
   */
  private async _performSyncInternal(): Promise<void> {
    const cursors: Record<string, number> = {};

    // Build cursors map from active channels (skip uninitialized and E2EE channels)
    for (const [cid, channel] of Object.entries(this.activeChannels)) {
      if (!channel?.state) continue; // Skip channels without initialized state

      // Skip E2EE channels — handled separately by EncryptionManager
      if (channel.data?.mls_enabled) continue;

      if (channel.state.lastSyncedEventSeq > 0) {
        cursors[cid] = channel.state.lastSyncedEventSeq;
      }
      // NEVER use created_at timestamp as a sync cursor. Channels without seq
      // are omitted here; the active-channel query owns their initial hydration.
    }

    const totalChannels = Object.keys(cursors).length;
    if (totalChannels === 0 && !this._removedSyncCursor) return;

    this.logger('info', `client:performSync() - Syncing ${totalChannels} channels`, {
      tags: ['sync'],
    });

    // Dispatch sync start event for UI progress tracking
    this.dispatchEvent({
      type: 'sync.started',
      total_channels: totalChannels,
    } as Event<ErmisChatGenerics>);

    if (totalChannels > 0 || this._removedSyncCursor) {
      const syncRequest: GlobalSyncRequest = {
        project_id: this.projectId,
        cursors,
        limit: 100,
      };

      // Include removed cursor for incremental removed-channels sync
      if (this._removedSyncCursor) {
        syncRequest.removed_cursor = this._removedSyncCursor;
      }

      let response: GlobalSyncResponse<ErmisChatGenerics>;
      let attempt = 0;
      const maxRetries = 3;
      while (true) {
        try {
          response = await this.globalSync(syncRequest);
          break;
        } catch (err) {
          attempt++;
          if (attempt > maxRetries) {
            this.dispatchEvent({
              type: 'sync.failed',
              error: err as Error,
            } as Event<ErmisChatGenerics>);
            throw err;
          }
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          this.logger(
            'warn',
            `client:performSync() - Sync failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`,
            { err, tags: ['sync'] },
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      // Collect user info for enrichment from all synced messages
      const users = Object.values(this.state.users);
      // Production APIs can wrap per-channel results in `channels`, while the
      // integration guide and older deployments return CIDs directly at root.
      const channelResults = response.channels ?? response;

      // Process each channel's sync result
      for (const [cid, syncResult] of Object.entries(channelResults)) {
        if (cid === 'channels' || cid === 'removed_channels') continue;

        const typedResult = syncResult as EventSyncResponse<ErmisChatGenerics>;
        if (!Array.isArray(typedResult?.events)) {
          this.logger('warn', `client:performSync() - Invalid sync payload for ${cid}, skipping`, {
            tags: ['sync'],
          });
          continue;
        }

        const channel = this.activeChannels[cid];
        if (!channel) {
          this.logger('warn', `client:performSync() - Channel ${cid} not in activeChannels, skipping`, {
            tags: ['sync'],
          });
          continue;
        }

        // Enrich messages in sync events with user info (#7)
        if (typedResult.events && users.length > 0) {
          for (const event of typedResult.events) {
            const eventAny = event as any;
            const message = event.message || eventAny.data?.message;
            if (message) {
              const enriched = enrichWithUserInfo([message as any], users)[0];
              event.message = enriched;
              if (eventAny.data?.message) eventAny.data.message = enriched;
            }
          }
        }

        await channel.applySyncResult(typedResult);

        // If has_more, continue syncing individually
        if (typedResult.has_more) {
          this.logger('info', `client:performSync() - Channel ${cid} has more events, syncing individually`, {
            tags: ['sync'],
          });
          await channel.syncUntilCaughtUp();
        }
      }

      // Note: We no longer do CID-missing detection here.
      // If a channel is in cursors but omitted from the response, it simply means there are no new events.
      // Channel removals are exclusively handled via the removed_channels payload below.

      // Process removed channels (user kicked/left/removed)
      if (response.removed_channels?.events?.length) {
        for (const removedEvent of response.removed_channels.events) {
          await this._removeChannelLocally(removedEvent.cid, removedEvent);
        }
      }

      // Persist removed cursor for next sync (#2)
      if (response.removed_channels?.next_cursor) {
        this._removedSyncCursor = response.removed_channels.next_cursor;
      }
    }

    this.logger('info', 'client:performSync() - Sync completed', { tags: ['sync'] });
    this.dispatchEvent({
      type: 'sync.completed',
    } as Event<ErmisChatGenerics>);

    // Persist sync state to IndexedDB for offline recovery (#4)
    this._persistSyncState().catch((err) => {
      this.logger('warn', 'client:performSync() - Failed to persist sync state to IndexedDB', {
        err,
        tags: ['sync', 'storage'],
      });
    });
  }

  /**
   * Save all active channels' sync state to IndexedDB.
   * Called automatically after performSync() completes.
   */
  private async _persistSyncState(): Promise<void> {
    const records: SyncStateRecord[] = [];
    for (const [cid, channel] of Object.entries(this.activeChannels)) {
      if (!channel?.state) continue;
      // Skip channels with no sync state AND no hidden sequences to persist
      if (
        channel.state.lastSyncedEventSeq === 0 &&
        channel.state.hiddenMessageSeqs.size === 0 &&
        channel.state.hiddenEventSeqs.size === 0 &&
        !channel.state.lastMsgSeqBeforeChatDeleted
      )
        continue;
      records.push({
        version: SYNC_STATE_VERSION,
        cid,
        lastSyncedEventSeq: channel.state.lastSyncedEventSeq,
        lastSyncedAt: channel.state.lastSyncedAt,
        hiddenEventSeqs: Array.from(channel.state.hiddenEventSeqs),
        hiddenMessageSeqs: Array.from(channel.state.hiddenMessageSeqs),
        lastMsgSeqBeforeChatDeleted: channel.state.lastMsgSeqBeforeChatDeleted,
        removedSyncCursor: this._removedSyncCursor,
        updatedAt: new Date().toISOString(),
      });
    }
    if (records.length > 0) {
      await this.messageStorage?.saveSyncStateBatch(records);
    }
    if (this._removedSyncCursor) {
      await this.messageStorage?.saveRemovedSyncCursor?.(this._removedSyncCursor);
    }
  }

  /**
   * Persist current sync state to IndexedDB immediately.
   * Call this after modifying channel state (e.g. hiddenMessageSeqs)
   * to ensure changes survive page refreshes.
   */
  async persistSyncState(): Promise<void> {
    return this._persistSyncState();
  }

  /**
   * Restore sync state from IndexedDB into active channel states.
   * Should be called after channels have been loaded (e.g., after queryChannels).
   * This enables subsequent performSync() calls to use event_seq cursors
   * instead of falling back to timestamp-based sync.
   */
  async restoreSyncState(): Promise<void> {
    try {
      const records = (await this.messageStorage?.loadAllSyncStates()) || [];
      const removedCursor = await this.messageStorage?.loadRemovedSyncCursor?.();
      if (removedCursor) {
        this._removedSyncCursor = removedCursor;
      }
      if (records.length === 0) return;

      this.logger('info', `client:restoreSyncState() - Restoring sync state for ${records.length} channels`, {
        tags: ['sync', 'storage'],
      });

      for (const record of records) {
        const channel = this.activeChannels[record.cid];
        if (channel?.state) {
          const isCurrentVersion = record.version === SYNC_STATE_VERSION;
          // Version 1 could persist channel.latest_event_seq from a partial
          // query and skip an event at that exact sequence. Replay once from
          // the queried message cursor; event application is idempotent.
          channel.state.lastSyncedEventSeq = isCurrentVersion ? record.lastSyncedEventSeq : 0;
          channel.state.lastSyncedAt = isCurrentVersion ? record.lastSyncedAt : null;
          channel.state.hiddenEventSeqs = new Set(record.hiddenEventSeqs || []);
          channel.state.hiddenMessageSeqs = new Set(record.hiddenMessageSeqs || []);
          channel.state.lastMsgSeqBeforeChatDeleted = record.lastMsgSeqBeforeChatDeleted;
        }
        // Restore removed cursor from the first record that has one
        if (record.removedSyncCursor && !this._removedSyncCursor) {
          this._removedSyncCursor = record.removedSyncCursor;
        }
      }
    } catch (err) {
      this.logger('warn', 'client:restoreSyncState() - Failed to restore sync state', {
        err,
        tags: ['sync', 'storage'],
      });
    }
  }

  /**
   * Remove a channel's persisted sync state from IndexedDB.
   * Called when a channel is deleted or the user is removed.
   */
  async removeSyncState(cid: string): Promise<void> {
    await this.messageStorage?.deleteSyncState(cid);
  }

  /**
   * Creates or instantiates an interactive `Channel` object locally based on type and custom data.
   * This does NOT immediately ping the API unless `channel.watch()` or `channel.create()` is subsequently called.
   *
   * @param type   - The strict channel type descriptor (e.g., `'messaging'`, `'team'`, `'livestream'`).
   * @param custom - Initial metadata or specific members to include in the channel.
   * @returns        A newly instantiated `Channel` object.
   */
  channel(type: string, custom?: ChannelData<ErmisChatGenerics>): Channel<ErmisChatGenerics>;
  /**
   * Creates or instantiates an interactive `Channel` object locally using a specific ID.
   *
   * @param type   - The strict channel type descriptor.
   * @param id     - The unique identifer (UUID / slug) for the channel.
   * @param custom - Initial metadata or specific members to include in the channel.
   * @returns        A newly instantiated `Channel` object.
   */
  channel(type: string, id: string, custom?: ChannelData<ErmisChatGenerics>): Channel<ErmisChatGenerics>;
  channel(
    channelType: string,
    channelIDOrCustom?: string | ChannelData<ErmisChatGenerics>,
    custom?: ChannelData<ErmisChatGenerics>,
  ): Channel<ErmisChatGenerics> {
    if (!this.userID) {
      throw Error('Call connectUser before creating a channel');
    }

    if (~channelType.indexOf(':')) {
      throw Error(`Invalid channel group ${channelType}, can't contain the : character`);
    }

    let channelID: string | undefined = undefined;
    let customData = custom || ({} as ChannelData<ErmisChatGenerics>);

    if (typeof channelIDOrCustom === 'string') {
      channelID = channelIDOrCustom;
    } else if (typeof channelIDOrCustom === 'object' && channelIDOrCustom !== null) {
      customData = channelIDOrCustom as ChannelData<ErmisChatGenerics>;
    }

    return this.getChannelById(channelType, channelID, customData);
  }

  getChannelById = (channelType: string, channelID: string | undefined, custom: ChannelData<ErmisChatGenerics>) => {
    const cid = `${channelType}:${channelID || ''}`;
    if (cid in this.activeChannels && !this.activeChannels[cid].disconnected) {
      const channel = this.activeChannels[cid];
      if (Object.keys(custom).length > 0) {
        channel.data = custom;
        channel._data = custom;
      }
      return channel;
    }
    const channel = new Channel<ErmisChatGenerics>(this, channelType, channelID, custom);
    this.activeChannels[channel.cid] = channel;

    return channel;
  };

  getChannel = (channelType: string, custom: ChannelData<ErmisChatGenerics>) => {
    const uuid = randomId();
    const id = `${this._requireProjectId('getChannel')}:${uuid}`;
    // only allow 1 channel object per cid
    const cid = `${channelType}:${id}`;
    if (cid in this.activeChannels && !this.activeChannels[cid].disconnected) {
      const channel = this.activeChannels[cid];
      if (Object.keys(custom).length > 0) {
        channel.data = custom;
        channel._data = custom;
      }
      return channel;
    }
    const channel = new Channel<ErmisChatGenerics>(this, channelType, id, custom);
    this.activeChannels[channel.cid] = channel;

    return channel;
  };

  /**
   * Creates a quick channel and immediately registers it on the server.
   * Quick channels are public group channels that anyone can join without an invitation.
   * The creator is added as the first member automatically.
   *
   * @param name - An optional display name for the channel.
   * @returns A promise that resolves to the created `Channel` object.
   */
  async createQuickChannel(name?: string): Promise<Channel<ErmisChatGenerics>> {
    if (!this.userID) {
      throw Error('Call connectUser before creating a channel');
    }

    const now = new Date();
    const formattedDate = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    const payload = {
      name: name || `Quick Channel - ${formattedDate}`,
      members: [this.userID],
      public: true,
    } as unknown as ChannelData<ErmisChatGenerics>;

    const quickChannel = this.channel('meeting', payload);
    await quickChannel.create();

    return quickChannel;
  }

  /**
   * Joins a quick channel by its ID.
   * Automatically checks whether the caller is already a member.
   * If not, it joins the channel and synchronizes state.
   *
   * @param channelId - The ID of the quick channel to join.
   * @returns A promise that resolves to the joined `Channel` object.
   */
  async joinQuickChannel(channelId: string): Promise<Channel<ErmisChatGenerics>> {
    if (!this.userID) {
      throw Error('Call connectUser before joining a channel');
    }

    const quickChannel = this.channel('meeting', channelId);
    await quickChannel.watch();

    const isMember = quickChannel.state.members && quickChannel.state.members[this.userID];

    if (!isMember) {
      await quickChannel.acceptInvite('join');
      await quickChannel.watch();
    }

    return quickChannel;
  }

  _normalizeExpiration(timeoutOrExpirationDate?: null | number | string | Date) {
    let pinExpires: null | string = null;
    if (typeof timeoutOrExpirationDate === 'number') {
      const now = new Date();
      now.setSeconds(now.getSeconds() + timeoutOrExpirationDate);
      pinExpires = now.toISOString();
    } else if (isString(timeoutOrExpirationDate)) {
      pinExpires = timeoutOrExpirationDate;
    } else if (timeoutOrExpirationDate instanceof Date) {
      pinExpires = timeoutOrExpirationDate.toISOString();
    }
    return pinExpires;
  }

  getUserAgent() {
    return (
      this.userAgent || `ermis-chat-sdk-javascript-client-${this.node ? 'node' : 'browser'}-${process.env.PKG_VERSION}`
    );
  }

  setUserAgent(userAgent: string) {
    this.userAgent = userAgent;
  }

  _enrichPublicAxiosOptions(
    options: AxiosRequestConfig & { config?: AxiosRequestConfig } = {
      params: {},
      headers: {},
      config: {},
    },
  ): AxiosRequestConfig {
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
    } = this.options.axiosRequestConfig || {};

    const params = {
      ...options.params,
      ...(axiosRequestConfigParams || {}),
    };

    return {
      params,
      headers: {
        'stream-auth-type': this.getAuthType(),
        'X-Stream-Client': this.getUserAgent(),
        ...(this.deviceId ? { 'X-Device-ID': this.deviceId } : {}),
        ...options.headers,
        ...(axiosRequestConfigHeaders || {}),
        [E2EE_BYTES_HEADER]: E2EE_BYTES_WIRE_FORMAT,
      },

      ...options.config,
      ...(axiosRequestConfigRest || {}),
    };
  }

  _enrichAxiosOptions(
    options: AxiosRequestConfig & { config?: AxiosRequestConfig } = {
      params: {},
      headers: {},
      config: {},
    },
  ): AxiosRequestConfig {
    let token = this._getToken();

    if (token && !token.startsWith('Bearer ')) {
      token = `Bearer ${token}`;
    }

    const authorization = token ? { Authorization: token } : undefined;

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
    } = this.options.axiosRequestConfig || {};

    let user_service_params = {
      ...options.params,
      ...(axiosRequestConfigParams || {}),
    };

    return {
      params: user_service_params,
      headers: {
        ...authorization,
        'stream-auth-type': this.getAuthType(),
        'X-Stream-Client': this.getUserAgent(),
        ...(this.deviceId ? { 'X-Device-ID': this.deviceId } : {}),
        ...options.headers,
        ...(axiosRequestConfigHeaders || {}),
        [E2EE_BYTES_HEADER]: E2EE_BYTES_WIRE_FORMAT,
      },

      ...options.config,
      ...(axiosRequestConfigRest || {}),
    };
  }

  _getToken() {
    if (!this.tokenManager) return null;

    return this.tokenManager.getToken();
  }

  _startCleaning() {
    const that = this;
    if (this.cleaningIntervalRef != null) {
      return;
    }
    this.cleaningIntervalRef = setInterval(() => {
      // call clean on the channel, used for calling the stop.typing event etc.
      for (const channel of Object.values(that.activeChannels)) {
        channel.clean();
      }
    }, 500);
  }

  _buildWSPayload = (client_request_id?: string) => {
    return JSON.stringify({
      user_id: this.userID,
      user_details: this.user,
      client_request_id,
    });
  };
}
