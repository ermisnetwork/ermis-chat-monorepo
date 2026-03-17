import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { StableWSConnection } from './connection';
import { EVENT_MAP } from './events';

export type Role = 'owner' | 'moder' | 'member' | 'pending' | 'skipped' | string;

/* Unknown Record */
export type UR = Record<string, unknown>;
export type DefaultGenerics = {
  attachmentType: UR;
  channelType: UR;
  commandType: LiteralStringForUnion;
  eventType: UR;
  messageType: UR;
  pollOptionType: UR;
  pollType: UR;
  reactionType: UR;
  userType: UR;
};

export type ExtendableGenerics = {
  attachmentType: UR;
  channelType: UR;
  commandType: string;
  eventType: UR;
  messageType: UR;
  pollOptionType: UR;
  pollType: UR;
  reactionType: UR;
  userType: UR;
};

/**
 * Response Types
 */

export type APIResponse = {
  duration?: string;
};

export type ChannelResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['channelType'] & {
    cid: string;
    id: string;
    type: string;
    created_at?: string;
    created_by?: UserResponse<ErmisChatGenerics> | null;
    deleted_at?: string;
    last_message_at?: string;
    member_count?: number;
    members: ChannelMemberResponse<ErmisChatGenerics>[];
    name?: string;
    own_capabilities?: string[];
    updated_at?: string;
    image?: string;
    description?: string;
    member_message_cooldown?: number;
    member_capabilities?: string[];
    is_pinned?: boolean;
    topics_enabled?: boolean;
    is_closed_topic?: boolean;
  };

export type QueryChannelsAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  channels: Omit<ChannelAPIResponse<ErmisChatGenerics>, keyof APIResponse>[];
};

export type QueryChannelAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse &
  ChannelAPIResponse<ErmisChatGenerics>;

export type ChannelAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  channel: ChannelResponse<ErmisChatGenerics>;
  members: ChannelMemberResponse<ErmisChatGenerics>[];
  messages: MessageResponse<ErmisChatGenerics>[];
  pinned_messages: MessageResponse<ErmisChatGenerics>[];
  hidden?: boolean;
  membership?: ChannelMembership<ErmisChatGenerics> | null;
  read?: ReadResponse<ErmisChatGenerics>[];
  topics?: QueryChannelAPIResponse<ErmisChatGenerics>[];
  watcher_count?: number;
  watchers?: UserResponse<ErmisChatGenerics>[];
  is_pinned?: boolean;
};

export type ChannelMemberResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  banned?: boolean;
  blocked?: boolean;
  channel_role?: Role;
  created_at?: string;
  updated_at?: string;
  user?: UserResponse<ErmisChatGenerics>;
  user_id?: string;
};

export type ConnectAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  Promise<void | ConnectionOpen<ErmisChatGenerics>>;

export type DeleteChannelAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  channel: ChannelResponse<ErmisChatGenerics>;
};

export type EventAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  event: Event<ErmisChatGenerics>;
};

export type FormatMessageResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = Omit<
  MessageResponse<{
    attachmentType: ErmisChatGenerics['attachmentType'];
    channelType: ErmisChatGenerics['channelType'];
    commandType: ErmisChatGenerics['commandType'];
    eventType: ErmisChatGenerics['eventType'];
    messageType: {};
    pollOptionType: ErmisChatGenerics['pollOptionType'];
    pollType: ErmisChatGenerics['pollType'];
    reactionType: ErmisChatGenerics['reactionType'];
    userType: ErmisChatGenerics['userType'];
  }>,
  'created_at' | 'pinned_at' | 'updated_at' | 'status'
> &
  ErmisChatGenerics['messageType'] & {
    created_at: Date;
    pinned_at: Date | null;
    status: string;
    updated_at: Date;
  };

export type MessageResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  MessageResponseBase<ErmisChatGenerics> & {
    quoted_message?: MessageResponseBase<ErmisChatGenerics>;
  };

export type MessageResponseBase<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  MessageBase<ErmisChatGenerics> & {
    type: MessageLabel;
    channel?: ChannelResponse<ErmisChatGenerics>;
    cid?: string;
    created_at?: string;
    deleted_at?: string;
    latest_reactions?: ReactionResponse<ErmisChatGenerics>[];
    mentioned_users?: UserResponse<ErmisChatGenerics>[];
    own_reactions?: ReactionResponse<ErmisChatGenerics>[] | null;
    pinned_at?: string | null;
    pinned_by?: UserResponse<ErmisChatGenerics> | null;
    reaction_counts?: { [key: string]: number } | null;
    reaction_scores?: { [key: string]: number } | null;
    reply_count?: number;
    status?: string;
    updated_at?: string;
  };

export type ReactionAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  message: MessageResponse<ErmisChatGenerics>;
  reaction: ReactionResponse<ErmisChatGenerics>;
};

export type ReactionResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  Reaction<ErmisChatGenerics> & {
    created_at: string;
    message_id: string;
    updated_at: string;
  };

export type ReadResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  last_read: string;
  user: UserResponse<ErmisChatGenerics>;
  last_read_message_id?: string;
  unread_messages?: number;
  last_send?: string;
};

// Thumb URL(thumb_url) is added considering video attachments as the backend will return the thumbnail in the response.
export type SendFileAPIResponse = APIResponse & { file: string; thumb_url?: string };

export type SendMessageAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  message: MessageResponse<ErmisChatGenerics>;
};

export type UpdateChannelAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  channel: ChannelResponse<ErmisChatGenerics>;
  members: ChannelMemberResponse<ErmisChatGenerics>[];
  message?: MessageResponse<ErmisChatGenerics>;
};

export type UserResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['userType'] & {
    id: string;
    name?: string;
    avatar?: string;
    about_me?: string;
    project_id?: string;
    email?: string;
    phone?: string;
  };
export type Contact = {
  project_id: string;
  user_id: string;
  other_id: string;
  relation_status: string;
  created_at: string;
  updated_at: string;
};

export type ContactResponse = APIResponse & {
  project_id_user_ids: {
    [key: string]: Contact[];
  };
};

export type ContactResult<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  contact_users: UserResponse<ErmisChatGenerics>[];
  block_users: UserResponse<ErmisChatGenerics>[];
};

export type ChannelQueryOptions = {
  messages?: {
    limit?: number;
    id_lt?: string;
    id_gt?: string;
    id_around?: string;
  };
};

export type ChannelStateOptions = {
  offlineMode?: boolean;
  skipInitialization?: string[];
};

export type MarkReadOptions<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  client_id?: string;
  user?: UserResponse<ErmisChatGenerics>;
  user_id?: string;
};

export type ErmisChatOptions = AxiosRequestConfig & {
  /**
   * Used to disable warnings that are triggered by using connectUser or connectAnonymousUser server-side.
   */
  allowServerSideConnect?: boolean;
  axiosRequestConfig?: AxiosRequestConfig;
  /**
   * Base url for User BE API (uss/v1). Defaults to baseURL + '/uss/v1' if not provided.
   */
  userBaseURL?: string;
  browser?: boolean;
  enableInsights?: boolean;
  /** experimental feature, please contact support if you want this feature enabled for you */
  logger?: Logger;
  /**
   * When network is recovered, we re-query the active channels on client. But in single query, you can recover
   * only 30 channels. So its not guaranteed that all the channels in activeChannels object have updated state.
   * Thus in UI sdks, state recovery is managed by components themselves, they don't rely on js client for this.
   *
   * `recoverStateOnReconnect` parameter can be used in such cases, to disable state recovery within js client.
   * When false, user/consumer of this client will need to make sure all the channels present on UI by
   * manually calling queryChannels endpoint.
   */
  recoverStateOnReconnect?: boolean;
  warmUp?: boolean;
  // Set the instance of StableWSConnection on chat client. Its purely for testing purpose and should
  // not be used in production apps.
  wsConnection?: StableWSConnection;
};

/**
 * Event Types
 */

export type Event<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = ErmisChatGenerics['eventType'] & {
  type: EventTypes;
  channel?: ChannelResponse<ErmisChatGenerics>;
  channel_id?: string;
  channel_type?: string;
  cid?: string;
  created_at?: string;
  hard_delete?: boolean;
  last_read_at?: string;
  last_read_message_id?: string;
  me?: UserResponse<ErmisChatGenerics>;
  member?: ChannelMemberResponse<ErmisChatGenerics>;
  message?: MessageResponse<ErmisChatGenerics>;
  online?: boolean;
  parent_id?: string;
  queriedChannels?: {
    channels: ChannelAPIResponse<ErmisChatGenerics>[];
    isLatestMessageSet?: boolean;
  };
  reaction?: ReactionResponse<ErmisChatGenerics>;
  received_at?: string | Date;
  unread_messages?: number;
  user?: UserResponse<ErmisChatGenerics>;
  user_id?: string;
  watcher_count?: number;
};

export type EventHandler<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = (
  event: Event<ErmisChatGenerics>,
) => void;

export type EventTypes = 'all' | keyof typeof EVENT_MAP;

/**
 * Filter Types
 */

export type AscDesc = 1 | -1;

export type ChannelFilters = {
  project_id?: string;
  type: ('messaging' | 'team' | 'topic')[];
  limit?: number;
  offset?: number;
  roles?: string[];
  other_roles?: string[];
  banned?: boolean;
  blocked?: boolean;
  include_pinned_messages?: boolean;
  parent_cid?: string;
  parent_id?: string;
  include_parent?: boolean;
};

export type ChannelSort = {
  field: string;
  direction: -1 | 1;
}[];

export type Attachment<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['attachmentType'] & {
    // main fields for ermis.
    id?: string;
    thumb_url?: string;
    content_disposition?: string;
    content_length?: number;
    content_type?: string;
    updated_at?: string;
    created_at?: string;
    message_id?: string;
    file_name?: string;
    url?: string;
    cid?: string;
    user_id?: string;
    asset_url?: string;
    author_icon?: string;
    author_link?: string;
    author_name?: string;
    color?: string;
    duration?: number;
    fallback?: string;
    file_size?: number | string;
    footer?: string;
    footer_icon?: string;
    image_url?: string;
    mime_type?: string;
    og_scrape_url?: string;
    original_height?: number;
    original_width?: number;
    pretext?: string;
    text?: string;
    title?: string;
    title_link?: string;
    type?: string;
    waveform_data?: Array<number>;
  };

export type ChannelData<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['channelType'] & {
    members?: string[];
    name?: string;
    is_pinned?: boolean;
  };

export type ChannelMembership<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  banned?: boolean;
  blocked?: boolean;
  channel_role?: Role;
  created_at?: string;
  updated_at?: string;
  user?: UserResponse<ErmisChatGenerics>;
};

export type ConnectionOpen<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  cid?: string;
  created_at?: string;
  me?: UserResponse<ErmisChatGenerics>;
  type?: string;
};

export type LiteralStringForUnion = string & {};

export type LogLevel = 'info' | 'error' | 'warn';

export type Logger = (logLevel: LogLevel, message: string, extraData?: Record<string, unknown>) => void;

export type Message<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = Partial<
  MessageBase<ErmisChatGenerics>
> & {
  id?: string;
  mentioned_all?: boolean;
  mentioned_users?: string[];
  cid?: string;
  forward_cid?: string;
  forward_message_id?: string;
  poll_type?: string; // single | multiple
  poll_choices?: string[];
  sticker_url?: string;
};

export type EditMessage = {
  text: string;
  mentioned_all?: boolean;
  mentioned_users?: string[];
};

export type PollMessage = {
  id?: string;
  text: string;
  poll_type: string; // single | multiple
  poll_choices: string[];
};

export type MessageBase<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['messageType'] & {
    id: string;
    attachments?: Attachment[];
    html?: string;
    mml?: string;
    parent_id?: string;
    pinned?: boolean;
    pinned_at?: string | null;
    quoted_message_id?: string;
    text?: string;
    user?: UserResponse | null;
    user_id?: string;
  };

export type MessageLabel = 'regular' | 'reply' | 'system' | 'signal' | 'poll' | 'sticker' | 'deleted' | 'error';

export type Reaction<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['reactionType'] & {
    type: string;
    message_id?: string;
    score?: number;
    user?: UserResponse | null;
    user_id?: string;
  };

export type MessageSetType = 'latest' | 'current' | 'new';

export type APIErrorResponse = {
  code: number;
  duration: string;
  message: string;
  more_info: string;
  StatusCode: number;
};

export class ErrorFromResponse<T> extends Error {
  code?: number;
  response?: AxiosResponse<T>;
  status?: number;
}

export type UsersResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  data: Array<UserResponse<ErmisChatGenerics>>;
  count: number;
  total: number;
  page: number;
  page_count: number;
};

export type AttachmentResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  attachments: Attachment<ErmisChatGenerics>[];
};

export type SignalData = {
  cid?: string;
  is_video?: boolean;
  action?: string;
  signal?: Object;
  metadata?: Object;
};

export enum CallAction {
  CREATE_CALL = 'create-call',
  ACCEPT_CALL = 'accept-call',
  SIGNAL_CALL = 'signal-call',
  CONNECT_CALL = 'connect-call',
  HEALTH_CALL = 'health-call',
  END_CALL = 'end-call',
  REJECT_CALL = 'reject-call',
  MISS_CALL = 'miss-call',
  UPGRADE_CALL = 'upgrade-call',
}

export enum CallStatus {
  RINGING = 'ringing',
  ENDED = 'ended',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export type CallEventType = 'incoming' | 'outgoing';

export type CallEventData = {
  type: CallEventType;
  callType: string;
  cid: string;
  callerInfo: UserCallInfo | undefined;
  receiverInfo: UserCallInfo | undefined;
  metadata?: Object;
};

export type UserCallInfo = {
  id: string;
  name?: string;
  avatar?: string;
};

export type Metadata = {
  address?: string;
};

export type INodeCall = {
  connect: (address: string) => Promise<void>;
  acceptConnection: () => Promise<void>;
  sendControlFrame: (packet: Uint8Array) => Promise<void>;
  sendAudioFrame: (packet: Uint8Array) => Promise<void>; // audio
  sendFrame: (packet: Uint8Array) => Promise<void>; // video delta
  beginWithGop: (packet: Uint8Array) => Promise<void>; // video key
  asyncRecv: () => Promise<Uint8Array>;
};

export type VideoConfig = {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  frameRate?: number;
  orientation?: number;
  rotation?: number;
  description?: any;
};

export type AudioConfig = {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: string;
};

export type TransceiverState = {
  audio_enable: boolean;
  video_enable: boolean;
};

export interface IMediaReceiverEvents {
  onConnected?: () => void;
  onTransceiverState?: (state: any) => void;
  onRequestConfig?: () => void;
  onRequestKeyFrame?: () => void;
  onEndCall?: () => void;
}

export enum FRAME_TYPE {
  VIDEO_CONFIG = 0,
  AUDIO_CONFIG = 1,
  VIDEO_KEY = 2,
  VIDEO_DELTA = 3,
  AUDIO = 4,
  ORIENTATION = 5,
  CONNECTED = 6,
  TRANSCEIVER_STATE = 7,
  REQUEST_CONFIG = 8,
  REQUEST_KEY_FRAME = 9,
  END_CALL = 10,
}
