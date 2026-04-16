/* eslint no-unused-vars: "off" */
/* global process */

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import https from 'https';
import WebSocket from 'isomorphic-ws';

import { Channel } from './channel';
import { ClientState } from './client_state';
import { StableWSConnection } from './connection';

import { TokenManager } from './token_manager';

import { isErrorResponse } from './errors';
import { EventSourcePolyfill } from 'event-source-polyfill';
import {
  addFileToFormData,
  axiosParamsSerializer,
  enrichWithUserInfo,
  ensureMembersUserInfoLoaded,
  getDirectChannelImage,
  getDirectChannelName,
  getLatestCreatedAt,
  isFunction,
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
  DefaultGenerics,
  ErrorFromResponse,
  Event,
  EventHandler,
  ExtendableGenerics,
  Logger,
  QueryChannelsAPIResponse,
  SendFileAPIResponse,
  ErmisChatOptions,
  UserResponse,
  ContactResponse,
  UsersResponse,
  ContactResult,
  Contact,
} from './types';

function isString(x: unknown): x is string {
  return typeof x === 'string' || x instanceof String;
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

  private eventSource: EventSourcePolyfill | null = null;

  /**
   * Initializes a new Ermis Chat Client instance.
   *
   * @param apiKey    - Your public Ermis Network API Key.
   * @param projectId - Your specific Project UUID pointing to the app config.
   * @param baseURL   - The API base endpoint assigned to your project.
   * @param options   - Additional connection rules and configuration options.
   */
  constructor(apiKey: string, projectId: string, baseURL: string, options?: ErmisChatOptions) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.listeners = {};
    this.state = new ClientState<ErmisChatGenerics>();

    const inputOptions = options || {};

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

    this.setBaseURL(baseURL);

    // WS connection is initialized when setUser is called
    this.wsConnection = null;
    this.wsPromise = null;
    this.setUserPromise = null;
    // keeps a reference to all the channels that are in use
    this.activeChannels = {};

    this.tokenManager = new TokenManager();
    this.consecutiveFailures = 0;
    this.defaultWSTimeout = 15000;

    this.axiosInstance.defaults.paramsSerializer = axiosParamsSerializer;

    this.logger = isFunction(inputOptions.logger) ? inputOptions.logger : () => null;
    this.recoverStateOnReconnect = this.options.recoverStateOnReconnect;
  }

  /**
   * Retrieves the globally registered Singleton instance of the ErmisChat client.
   * If the instance lacks existence, it initializes a new one.
   *
   * @param key       - Your public Ermis Network API Key.
   * @param projectId - Your specific Project UUID.
   * @param baseURL   - The API base endpoint.
   * @param options   - Connection options.
   * @returns           The shared ErmisChat client instance.
   */
  public static getInstance<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics>(
    key: string,
    projectId: string,
    baseURL: string,
    options?: ErmisChatOptions,
  ): ErmisChat<ErmisChatGenerics> {
    if (!ErmisChat._instance) {
      ErmisChat._instance = new ErmisChat<ErmisChatGenerics>(key, projectId, baseURL, options);
    }

    return ErmisChat._instance as ErmisChat<ErmisChatGenerics>;
  }

  async refreshNewToken(refresh_token: string) {
    return await this.post<APIResponse>(this.userBaseURL + '/refresh_token', { refresh_token });
  }

  getAuthType() {
    return 'jwt';
  }

  setBaseURL(baseURL: string) {
    this.baseURL = baseURL;
    this.userBaseURL = this.options.userBaseURL || baseURL + '/uss/v1';
    this.wsBaseURL = this.baseURL.replace('http', 'ws').replace(':3030', ':8800');
  }

  async getExternalAuthToken(user: UserResponse<ErmisChatGenerics>, token: string | null) {
    const params: any = { apikey: this.apiKey, name: user.name };
    if (user.avatar) {
      params.avatar = user.avatar;
    }
    const url = this.userBaseURL + '/get_token/external_auth';
    const query = new URLSearchParams(params).toString();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      const tokenStr = typeof token === 'string' && token.startsWith('Bearer ') ? token : `Bearer ${token}`;
      headers['Authorization'] = tokenStr;
    }
    const response = await fetch(`${url}?${query}`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      let errorMsg = '';
      try {
        const errorData = await response.json();
        errorMsg = errorData.message || JSON.stringify(errorData);
      } catch {
        errorMsg = await response.text();
      }
      throw new Error(errorMsg);
    }
    return await response.json();
  }

  /**
   * Connects a user to the Ermis network and establishes the WebSocket connection.
   * This is the primary method to authenticate your client application.
   *
   * @param user                - The User object containing `id`, `name`, and optional `avatar`.
   * @param userTokenOrProvider - The JWT token or an async token provider function.
   * @param extenal_auth        - Set to `true` to use your custom backend external authentication flow.
   * @returns                     A promise resolving to the API connection response once authenticated.
   */
  connectUser = async (
    user: UserResponse<ErmisChatGenerics>,
    userTokenOrProvider: string | null,
    extenal_auth?: boolean, // pass true if you are using external auth
  ) => {
    this.logger('info', 'client:connectUser() - started', {
      tags: ['connection', 'client'],
    });
    if (!user.id) {
      throw new Error('The "id" field on the user is missing');
    }

    // If external auth is enabled, get the token from the server
    if (extenal_auth) {
      const external_auth_token = await this.getExternalAuthToken(user, userTokenOrProvider);

      userTokenOrProvider = external_auth_token.token;
      user.id = external_auth_token.user_id;
    }

    /**
     * Calling connectUser multiple times is potentially the result of a  bad integration, however,
     * If the user id remains the same we don't throw error
     */
    if (this.userID === user.id && this.setUserPromise) {
      console.warn(
        'Consecutive calls to connectUser is detected, ideally you should only call this function once in your app.',
      );
      return this.setUserPromise;
    }

    if (this.userID) {
      throw new Error(
        'Use client.disconnect() before trying to connect as a different user. connectUser was called twice.',
      );
    }

    if (this.node && !this.options.allowServerSideConnect) {
      console.warn(
        'Please do not use connectUser server side. connectUser impacts MAU and concurrent connection usage and thus your bill. If you have a valid use-case, add "allowServerSideConnect: true" to the client options to disable this warning.',
      );
    }

    // we generate the client id client side
    this.userID = user.id;

    const setTokenPromise = this._setToken(user, userTokenOrProvider);
    this._setUser(user);
    this.state.updateUser({ id: user.id, name: user?.name || user.id, avatar: user?.avatar || '' });

    const wsPromise = this.openConnection();

    this.setUserPromise = Promise.all([setTokenPromise, wsPromise]).then(
      (result) => result[1], // We only return connection promise;
    );

    try {
      const result = await this.setUserPromise;
      // Call SSE after successful connect
      await this.connectToSSE();
      return result;
    } catch (err) {
      this.disconnectUser();
      throw err;
    }
  };

  setUser = this.connectUser;

  _setToken = (user: UserResponse<ErmisChatGenerics>, userTokenOrProvider: string | null) =>
    this.tokenManager.setTokenOrProvider(userTokenOrProvider, user);

  _setUser(user: UserResponse<ErmisChatGenerics>) {
    this.user = { ...user };
    this.userID = user.id;
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

    // If the event is channel.created, handle it asynchronously
    if (event.type === 'channel.created') {
      this._handleChannelCreatedEvent(event).then(() => {
        this._afterDispatchEvent(event);
      });
    } else {
      const postListenerCallbacks = this._handleClientEvent(event);

      // channel event handlers
      const cid = event.cid;
      const channel = cid ? this.activeChannels[cid] : undefined;
      if (channel) {
        channel._handleChannelEvent(event);
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
    const channel = cid ? this.activeChannels[cid] : undefined;
    if (channel) {
      channel._handleChannelEvent(event);
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
    const event = JSON.parse(jsonString) as Event<ErmisChatGenerics>;
    this.dispatchEvent(event);
  };

  _updateMemberWatcherReferences = (user: UserResponse<ErmisChatGenerics>) => {
    const refMap = this.state.userChannelReferences[user.id] || {};
    for (const channelID in refMap) {
      const channel = this.activeChannels[channelID];
      if (channel?.state) {
        if (channel.state.members[user.id]) {
          channel.state.members[user.id].user = user;
        }
        if (channel.state.watchers[user.id]) {
          channel.state.watchers[user.id] = user;
        }
        if (channel.state.read[user.id]) {
          channel.state.read[user.id].user = user;
        }
      }
    }
  };

  _updateUserReferences = this._updateMemberWatcherReferences;

  _updateUserMessageReferences = (user: UserResponse<ErmisChatGenerics>) => {
    const refMap = this.state.userChannelReferences[user.id] || {};

    for (const channelID in refMap) {
      const channel = this.activeChannels[channelID];

      if (!channel) continue;

      const state = channel.state;

      /** update the messages from this user. */
      state?.updateUserMessages(user);
    }
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

  _handleClientEvent(event: Event<ErmisChatGenerics>) {
    const client = this;
    const postListenerCallbacks = [];
    this.logger('info', `client:_handleClientEvent - Received event of type { ${event.type} }`, {
      tags: ['event', 'client'],
      event,
    });

    if (event.type === 'health.check' && event.me) {
    }

    if ((event.type === 'channel.deleted' || event.type === 'notification.channel_deleted') && event.cid) {
      client.state.deleteAllChannelReference(event.cid);
      this.activeChannels[event.cid]?._disconnect();

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
        client.state.deleteAllChannelReference(event.cid);
        this.activeChannels[event.cid]?._disconnect();

        postListenerCallbacks.push(() => {
          if (!event.cid) return;

          delete this.activeChannels[event.cid];
        });
      }
    }
    if (event.type === 'notification.invite_accepted') {
      //TODO handle channel list and invited channels here
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

    const cids = Object.keys(this.activeChannels);
    if (cids.length && this.recoverStateOnReconnect) {
      this.logger('info', `client:recoverState() - Start the querying of ${cids.length} channels`, {
        tags: ['connection', 'client'],
      });

      const filter: ChannelFilters = {
        type: ['messaging', 'team'],
      };
      const sort: [] = [];
      const options = {
        message_limit: 25,
      };

      await this.queryChannels(filter, sort, options);

      this.logger('info', 'client:recoverState() - Querying channels finished', { tags: ['connection', 'client'] });
      this.dispatchEvent({
        type: 'connection.recovered',
      } as Event<ErmisChatGenerics>);
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
    if (this.eventSource) {
      this.logger('info', 'client:connectToSSE() - SSE connection already established', {});
      return;
    }
    let token = this._getToken();

    if (!token?.startsWith('Bearer ')) {
      token = `Bearer ${token}`;
    }
    const headers = {
      method: 'GET',
      Authorization: token,
    };
    this.eventSource = new EventSourcePolyfill(this.userBaseURL + '/sse/subscribe', {
      headers,
      heartbeatTimeout: 60000,
    });
    this.eventSource.onopen = () => {
      this.logger('info', 'client:connectToSSE() - SSE connection established', {});
    };
    this.eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      this.logger('info', `client:connectToSSE() - SSE message received event :  ${JSON.stringify(data)}`, { event });

      if (data.type === 'AccountUserChainProjects') {
        let user: UserResponse = {
          name: data.name,
          id: data.id,
          avatar: data.avatar,
          about_me: data.about_me,
          project_id: data.project_id,
        };

        if (this.user?.id === user.id) {
          this.user = { ...this.user, ...user };
        }

        this.state.updateUser(user);

        const userInfo = {
          id: user.id,
          name: user.name ? user.name : user.id,
          avatar: user?.avatar || '',
        };

        this._updateMemberWatcherReferences(userInfo);
        this._updateUserMessageReferences(userInfo);

        Object.values(this.activeChannels).forEach((channel) => {
          if (channel.data?.type === 'messaging' && Object.keys(channel.state.members).length === 2) {
            const otherMember = Object.values(channel.state.members).find((member) => member.user?.id !== this.userID);
            if (otherMember && otherMember.user?.id === user.id) {
              // Cập nhật tên và avatar channel theo user vừa đổi thông tin
              channel.data.name = user.name || user.id;
              channel.data.image = user.avatar || '';
            }
          }
        });

        if (onCallBack) {
          onCallBack(data);
        }
      }
    };
    this.eventSource.onerror = (event: any) => {
      this.logger('error', `client:connectToSSE() - SSE connection error : ${JSON.stringify(event.data)} `, { event });
      if (event.status === 401) {
        this.logger('error', 'client:connectToSSE() - Unauthorized (401). Aborting the connection.', {});
        this.disconnectFromSSE();
      } else if (
        this.eventSource?.readyState === EventSourcePolyfill.CLOSED ||
        this.eventSource?.readyState === EventSourcePolyfill.CONNECTING
      ) {
        this.eventSource.close();
        setTimeout(() => {
          this.logger('info', 'client:connectToSSE() - Reconnecting to SSE', {});
          this.connectToSSE(onCallBack);
        }, 3000);
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

  async queryUsers(page_size?: string, page?: number): Promise<UsersResponse> {
    const defaultOptions = {
      presence: false,
    };

    // Make sure we wait for the connect promise if there is a pending one
    await this.wsPromise;

    let project_id = this.projectId;
    // Return a list of users
    const data = await this.get<UsersResponse>(this.userBaseURL + '/users', {
      project_id,
      page,
      page_size,
    });

    this.state.updateUsers(data.data);

    return data;
  }

  async queryUser(user_id: string): Promise<UserResponse<ErmisChatGenerics>> {
    const project_id = this.projectId;

    const userResponse = await this.get<UserResponse<ErmisChatGenerics>>(this.userBaseURL + '/users/' + user_id, {
      project_id,
    });

    this.state.updateUser(userResponse);
    return userResponse;
  }

  async getBatchUsers(users: string[], page?: number, page_size?: number) {
    let project_id = this.projectId;

    const usersRepsonse = await this.post<UsersResponse>(
      this.userBaseURL + '/users/batch?page=1&page_size=10000',
      { users, project_id },
      { page, page_size },
    );

    this.state.updateUsers(usersRepsonse.data);

    return usersRepsonse.data || [];
  }

  async searchUsers(page: number, page_size: number, name?: string): Promise<UsersResponse> {
    let project_id = this.projectId;

    const usersResponse = await this.post<UsersResponse>(this.userBaseURL + '/users/search', undefined, {
      page,
      page_size,
      name,
      project_id,
    });

    // this.state.updateUsers(usersResponse.data);

    return usersResponse;
  }

  async queryContacts(): Promise<ContactResult> {
    let project_id = this.projectId;
    const contactResponse = await this.post<ContactResponse>(this.baseURL + '/contacts/list', { project_id });
    const userIds = contactResponse.project_id_user_ids[project_id];
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

  async uploadFile(file: File) {
    const formData = new FormData();
    formData.append('avatar', file);
    let response = await this.post<{ avatar: string }>(this.userBaseURL + '/users/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    if (this.user) {
      this.user.avatar = response.avatar;
      const new_user = { ...this.user, avatar: response.avatar };
      this.state.updateUser(new_user);
    }

    return response;
  }
  async updateProfile(name: string, about_me: string) {
    let body = {
      name,
      about_me,
    };
    let response = await this.patch<UserResponse<ErmisChatGenerics>>(this.userBaseURL + '/users/update', body);
    this.user = response;
    this.state.updateUser(response);
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

    let project_id = this.projectId;

    // Return a list of channels
    const payload = {
      filter_conditions: { ...filterConditions, project_id },
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

    const membersInfo = filterConditions.parent_cid
      ? Object.values(this.state.users)
      : await this.getBatchUsers(memberIds);
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

    const { channels, userIds } = this.hydrateChannels(data.channels, stateOptions);

    // if (userIds.length > 0) {
    //   await this.getBatchUsers(userIds);
    // }

    console.log('---channels---', channels);

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
    let project_id = this.projectId;

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
    const id = `${this.projectId}:${uuid}`;
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

  _enrichAxiosOptions(
    options: AxiosRequestConfig & { config?: AxiosRequestConfig } = {
      params: {},
      headers: {},
      config: {},
    },
  ): AxiosRequestConfig {
    let token = this._getToken();

    if (!token?.startsWith('Bearer ')) {
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
        ...options.headers,
        ...(axiosRequestConfigHeaders || {}),
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
