import { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { StableWSConnection } from './connection';
import { EVENT_MAP } from './events';

export type Role = 'admin' | 'user' | 'guest' | 'anonymous' | 'channel_member' | 'channel_moderator' | string;

export type RequireAtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<keyof T, K>>>;
}[keyof T];

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
    disabled: boolean;
    frozen: boolean;
    id: string;
    type: string;
    config?: ChannelConfigWithInfo<ErmisChatGenerics>;
    cooldown?: number;
    created_at?: string;
    created_by?: UserResponse<ErmisChatGenerics> | null;
    created_by_id?: string;
    deleted_at?: string;
    hidden?: boolean;
    invites?: string[];
    joined?: boolean;
    last_message_at?: string;
    member_count?: number;
    members: ChannelMemberResponse<ErmisChatGenerics>[];
    muted?: boolean;
    name?: string;
    own_capabilities?: string[];
    team?: string;
    truncated_at?: string;
    truncated_by?: UserResponse<ErmisChatGenerics>;
    truncated_by_id?: string;
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

export type ChannelUpdateOptions = {
  hide_history?: boolean;
  skip_push?: boolean;
};

export type ChannelMemberResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  banned?: boolean;
  channel_role?: Role;
  created_at?: string;
  invite_accepted_at?: string;
  invite_rejected_at?: string;
  invited?: boolean;
  is_moderator?: boolean;
  notifications_muted?: boolean;
  role?: string;
  shadow_banned?: boolean;
  status?: string;
  updated_at?: string;
  user?: UserResponse<ErmisChatGenerics>;
  user_id?: string;
};

export type CommandResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  Partial<CreatedAtUpdatedAt> & {
    args?: string;
    description?: string;
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
    args?: string;
    before_message_send_failed?: boolean;
    channel?: ChannelResponse<ErmisChatGenerics>;
    cid?: string;
    command?: string;
    command_info?: { name?: string };
    created_at?: string;
    deleted_at?: string;
    deleted_reply_count?: number;
    latest_reactions?: ReactionResponse<ErmisChatGenerics>[];
    mentioned_users?: UserResponse<ErmisChatGenerics>[];
    message_text_updated_at?: string;
    moderation_details?: ModerationDetailsResponse;
    own_reactions?: ReactionResponse<ErmisChatGenerics>[] | null;
    pin_expires?: string | null;
    pinned_at?: string | null;
    pinned_by?: UserResponse<ErmisChatGenerics> | null;
    poll?: PollResponse<ErmisChatGenerics>;
    reaction_counts?: { [key: string]: number } | null;
    reaction_scores?: { [key: string]: number } | null;
    reply_count?: number;
    shadowed?: boolean;
    status?: string;
    thread_participants?: UserResponse<ErmisChatGenerics>[];
    updated_at?: string;
  };

export type ModerationDetailsResponse = {
  action: 'MESSAGE_RESPONSE_ACTION_BOUNCE' | (string & {});
  error_msg: string;
  harms: ModerationHarmResponse[];
  original_text: string;
};

export type ModerationHarmResponse = {
  name: string;
  phrase_list_ids: number[];
};

export type OwnUserBase<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  // mutes: Mute<ErmisChatGenerics>[];
  total_unread_count: number;
  unread_channels: number;
  unread_count: number;
  unread_threads: number;
  invisible?: boolean;
  roles?: string[];
};

export type OwnUserResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  UserResponse<ErmisChatGenerics> & OwnUserBase<ErmisChatGenerics>;

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
  pending_message_metadata?: Record<string, string> | null;
};

export type TruncateChannelAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  channel: ChannelResponse<ErmisChatGenerics>;
  message?: MessageResponse<ErmisChatGenerics>;
};

export type UpdateChannelAPIResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = APIResponse & {
  channel: ChannelResponse<ErmisChatGenerics>;
  members: ChannelMemberResponse<ErmisChatGenerics>[];
  message?: MessageResponse<ErmisChatGenerics>;
};

export type UserResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = User<ErmisChatGenerics> & {
  project_id?: string;
  created_at?: string;
  updated_at?: string;
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

export type ChannelQueryOptions<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  client_id?: string;
  connection_id?: string;
  data?: ChannelResponse<ErmisChatGenerics>;
  hide_for_creator?: boolean;
  members?: PaginationOptions;
  messages?: MessagePaginationOptions;
  presence?: boolean;
  state?: boolean;
  watch?: boolean;
  watchers?: PaginationOptions;
};

export type ChannelStateOptions = {
  offlineMode?: boolean;
  skipInitialization?: string[];
};

export type MarkReadOptions<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  client_id?: string;
  connection_id?: string;
  thread_id?: string;
  user?: UserResponse<ErmisChatGenerics>;
  user_id?: string;
};

export type PaginationOptions = {
  created_at_after?: string | Date;
  created_at_after_or_equal?: string | Date;
  created_at_before?: string | Date;
  created_at_before_or_equal?: string | Date;
  id_gt?: string;
  id_gte?: string;
  id_lt?: string;
  id_lte?: string;
  limit?: number;
  offset?: number;
};

export type MessagePaginationOptions = PaginationOptions & {
  created_at_around?: string | Date;
  id_around?: string;
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
  clear_history?: boolean;
  connection_id?: string;
  // event creation timestamp, format Date ISO string
  created_at?: string;
  // id of the message that was marked as unread - all the following messages are considered unread. (notification.mark_unread)
  first_unread_message_id?: string;
  hard_delete?: boolean;
  // creation date of a message with last_read_message_id, formatted as Date ISO string
  last_read_at?: string;
  last_read_message_id?: string;
  mark_messages_deleted?: boolean;
  me?: OwnUserResponse<ErmisChatGenerics>;
  member?: ChannelMemberResponse<ErmisChatGenerics>;
  message?: MessageResponse<ErmisChatGenerics>;
  mode?: string;
  online?: boolean;
  parent_id?: string;
  poll?: PollResponse<ErmisChatGenerics>;
  poll_vote?: PollVote<ErmisChatGenerics>;
  queriedChannels?: {
    channels: ChannelAPIResponse<ErmisChatGenerics>[];
    isLatestMessageSet?: boolean;
  };
  reaction?: ReactionResponse<ErmisChatGenerics>;
  received_at?: string | Date;
  team?: string;
  // @deprecated number of all unread messages across all current user's unread channels, equals unread_count
  total_unread_count?: number;
  // number of all current user's channels with at least one unread message including the channel in this event
  unread_channels?: number;
  // number of all unread messages across all current user's unread channels
  unread_count?: number;
  // number of unread messages in the channel from this event (notification.mark_unread)
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

/**
 * Base Types
 */

export type Action = {
  name?: string;
  style?: string;
  text?: string;
  type?: string;
  value?: string;
};

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

    // old fields.
    actions?: Action[];
    asset_url?: string;
    author_icon?: string;
    author_link?: string;
    author_name?: string;
    color?: string;
    duration?: number;
    fallback?: string;
    fields?: Field[];
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

export type ChannelConfigFields = {
  reminders: boolean;
  connect_events?: boolean;
  custom_events?: boolean;
  mark_messages_pending?: boolean;
  max_message_length?: number;
  message_retention?: string;
  mutes?: boolean;
  name?: string;
  polls?: boolean;
  push_notifications?: boolean;
  quotes?: boolean;
  reactions?: boolean;
  read_events?: boolean;
  replies?: boolean;
  search?: boolean;
  typing_events?: boolean;
  uploads?: boolean;
  url_enrichment?: boolean;
};

export type ChannelConfigWithInfo<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ChannelConfigFields &
    CreatedAtUpdatedAt & {
      commands?: CommandResponse<ErmisChatGenerics>[];
    };

export type ChannelData<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['channelType'] & {
    members?: string[];
    name?: string;
    is_pinned?: boolean;
  };

export type ChannelMembership<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  banned?: boolean;
  channel_role?: Role;
  created_at?: string;
  is_moderator?: boolean;
  notifications_muted?: boolean;
  role?: string;
  shadow_banned?: boolean;
  status?: string;
  updated_at?: string;
  user?: UserResponse<ErmisChatGenerics>;
};

export type Configs<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = Record<
  string,
  ChannelConfigWithInfo<ErmisChatGenerics> | undefined
>;

export type ConnectionOpen<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  connection_id: string;
  cid?: string;
  created_at?: string;
  me?: OwnUserResponse<ErmisChatGenerics>;
  type?: string;
};

export type CreatedAtUpdatedAt = {
  created_at: string;
  updated_at: string;
};

export type Field = {
  short?: boolean;
  title?: string;
  value?: string;
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
    attachments?: Attachment<ErmisChatGenerics>[];
    html?: string;
    mml?: string;
    parent_id?: string;
    pin_expires?: string | null;
    pinned?: boolean;
    pinned_at?: string | null;
    poll_id?: string;
    quoted_message_id?: string;
    show_in_channel?: boolean;
    silent?: boolean;
    text?: string;
    user?: UserResponse<ErmisChatGenerics> | null;
    user_id?: string;
  };

export type MessageLabel = 'deleted' | 'ephemeral' | 'error' | 'regular' | 'reply' | 'system';

export type SendMessageOptions = {
  force_moderation?: boolean;
  is_pending_message?: boolean;
  keep_channel_hidden?: boolean;
  pending?: boolean;
  pending_message_metadata?: Record<string, string>;
  skip_enrich_url?: boolean;
  skip_push?: boolean;
};

export type Mute<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  created_at: string;
  target: UserResponse<ErmisChatGenerics>;
  updated_at: string;
  user: UserResponse<ErmisChatGenerics>;
};

export type Reaction<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['reactionType'] & {
    type: string;
    message_id?: string;
    score?: number;
    user?: UserResponse<ErmisChatGenerics> | null;
    user_id?: string;
  };

export type TokenOrProvider = null | string | TokenProvider | undefined;

export type TokenProvider = () => Promise<string>;

export type User<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = ErmisChatGenerics['userType'] & {
  id: string;
  name?: string;
  avatar?: string;
  about_me?: string;
  email?: string;
  phone?: string;
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

export type PollResponse<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> =
  ErmisChatGenerics['pollType'] & {
    answers_count: number;
    created_at: string;
    created_by: UserResponse<ErmisChatGenerics> | null;
    created_by_id: string;
    enforce_unique_vote: boolean;
    id: string;
    latest_answers: PollVote<ErmisChatGenerics>[];
    latest_votes_by_option: Record<string, PollVote<ErmisChatGenerics>[]>;
    max_votes_allowed: number;
    name: string;
    options: PollOption<ErmisChatGenerics>[];
    updated_at: string;
    vote_count: number;
    vote_counts_by_option: Record<string, number>;
    allow_answers?: boolean;
    allow_user_suggested_options?: boolean;
    channel?: ChannelAPIResponse<ErmisChatGenerics> | null;
    cid?: string;
    description?: string;
    is_closed?: boolean;
    own_votes?: PollVote<ErmisChatGenerics>[];
  };

export type PollOption<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  created_at: string;
  id: string;
  poll_id: string;
  text: string;
  updated_at: string;
  vote_count: number;
  votes?: PollVote<ErmisChatGenerics>[];
};

export type PollVote<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = {
  created_at: string;
  id: string;
  is_answer: boolean;
  poll_id: string;
  user_id: string;
  answer_text?: string;
  option_id?: string;
  user?: UserResponse<ErmisChatGenerics>;
};

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
