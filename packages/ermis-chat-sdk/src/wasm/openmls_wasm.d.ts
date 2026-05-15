/* tslint:disable */
/* eslint-disable */
/**
 * Test function to verify the module is working
 */
export function greet(): void;
/**
 * Compute the deterministic channel_id for E2EE Messaging (DM) channels.
 *
 * Replicates the server-side `hash_channel_id()` in bellboy/src/util/check.rs.
 * Only needed for E2EE DM creation — standard (non-E2EE) Messaging channels
 * have their channel_id computed server-side.
 *
 * Algorithm:
 * 1. Sort user_ids alphabetically
 * 2. Concatenate (no separator)
 * 3. SHA-256 → hex string
 * 4. Truncate to 36 chars
 * 5. Return "{project_id}:{hash36}"
 *
 * # Example
 * ```javascript
 * const channelId = hash_channel_id("proj-uuid", ["alice", "bob"]);
 * const cid = `messaging:${channelId}`;
 * const group = Group.create_with_cid(provider, identity, cid);
 * ```
 */
export function hash_channel_id(project_id: string, user_ids: string[]): string;
/**
 * Initialize the WASM module
 *
 * Call this once at startup to set up panic hooks for better error messages.
 */
export function init(): void;
/**
 * Validate raw key package bytes without constructing a KeyPackage object.
 *
 * Performs full validation: TLS deserialization, signature verification,
 * protocol version check, lifetime check, init_key ≠ encryption_key.
 *
 * # Arguments
 * * `bytes` - TLS-serialized KeyPackage bytes (from server API)
 *
 * # Returns
 * `true` if the KeyPackage is valid, `false` otherwise.
 *
 * # Example
 * ```javascript
 * const isValid = validate_key_package_bytes(kpBytes);
 * if (!isValid) console.warn("Invalid KeyPackage!");
 * ```
 */
export function validate_key_package_bytes(bytes: Uint8Array): boolean;
/**
 * Type of processed message
 */
export enum MessageType {
  /**
   * Application message (encrypted user content)
   */
  ApplicationMessage = 0,
  /**
   * Proposal message (add/remove/update)
   */
  Proposal = 1,
  /**
   * Commit message (finalizing proposals)
   */
  Commit = 2,
}
/**
 * Error codes for MLS operations
 */
export enum MlsErrorCode {
  /**
   * Error during serialization
   */
  SerializationError = 0,
  /**
   * Error during deserialization
   */
  DeserializationError = 1,
  /**
   * Group is not in operational state
   */
  GroupNotOperational = 2,
  /**
   * Member not found in group
   */
  MemberNotFound = 3,
  /**
   * Invalid message format or content
   */
  InvalidMessage = 4,
  /**
   * Welcome message was expected but not generated
   */
  NoWelcome = 5,
  /**
   * Invalid CID format
   */
  InvalidCid = 6,
  /**
   * Storage operation failed
   */
  StorageError = 7,
  /**
   * Crypto operation failed
   */
  CryptoError = 8,
  /**
   * Invalid state
   */
  InvalidState = 9,
  /**
   * External commit failed
   */
  ExternalCommitError = 10,
}
/**
 * Messages generated when adding a member (legacy format)
 */
export class AddMessages {
  private constructor();
  free(): void;
  readonly group_info: Uint8Array | undefined;
  readonly commit: Uint8Array;
  readonly welcome: Uint8Array;
  readonly proposal: Uint8Array;
}
/**
 * Bundle containing commit message and optional welcome
 */
export class CommitBundle {
  private constructor();
  free(): void;
  /**
   * Check if this commit includes a welcome (new members added)
   */
  has_welcome(): boolean;
  /**
   * Get commit as Uint8Array
   */
  commit_as_uint8array(): Uint8Array;
  /**
   * Get welcome as Uint8Array (returns empty if no welcome)
   */
  welcome_as_uint8array(): Uint8Array;
  /**
   * Get the group info bytes
   */
  readonly group_info: Uint8Array | undefined;
  /**
   * Get the commit message bytes
   */
  readonly commit: Uint8Array;
  /**
   * Get the welcome message bytes (if any new members were added)
   */
  readonly welcome: Uint8Array | undefined;
}
/**
 * Result of an external join (self-join with GroupInfo)
 */
export class ExternalJoinResult {
  private constructor();
  free(): void;
  /**
   * Get the joined group
   */
  readonly group: Group | undefined;
  /**
   * Get the commit message to broadcast
   */
  readonly commit: Uint8Array;
}
/**
 * An MLS Group representing an encrypted channel
 */
export class Group {
  private constructor();
  free(): void;
  /**
   * Create a new group (legacy API, uses group_id string directly)
   */
  static create_new(provider: Provider, founder: Identity, group_id: string): Group;
  /**
   * Persist the group's current state to the Provider's storage.
   *
   * MUST be called after processing application messages (decrypt) to save
   * the updated ratchet/secret tree state. Without this, a Provider restore
   * (e.g., on page reload) will load stale ratchet state, causing
   * SecretReuseError for messages that were already decrypted.
   */
  save_state(provider: Provider): void;
  /**
   * Join a group via External Commit
   *
   * This allows a user to join a group without needing a Welcome message,
   * using only the GroupInfo.
   *
   * # Arguments
   * * `provider` - Crypto provider
   * * `identity` - Identity of the joiner
   * * `group_info` - Serialized GroupInfo bytes
   * * `ratchet_tree` - Optional ratchet tree
   *
   * # Returns
   * ExternalJoinResult containing the joined group and commit message to broadcast
   */
  static join_external(provider: Provider, identity: Identity, group_info: Uint8Array, ratchet_tree?: RatchetTree | null): ExternalJoinResult;
  /**
   * Create a new group with a CID from Ermis
   *
   * # Arguments
   * * `provider` - Crypto provider
   * * `founder` - Identity of the group creator
   * * `cid` - Channel ID from Ermis (e.g., "team:channel_abc123")
   *
   * # Example
   * ```javascript
   * const group = Group.create_with_cid(provider, identity, "team:my_channel");
   * ```
   */
  static create_with_cid(provider: Provider, founder: Identity, cid: string): Group;
  /**
   * Join a group using a Welcome message
   *
   * # Arguments
   * * `provider` - Crypto provider
   * * `welcome` - Serialized Welcome message bytes
   * * `ratchet_tree` - Optional ratchet tree (if not embedded in welcome)
   */
  static join_with_welcome(provider: Provider, welcome: Uint8Array, ratchet_tree?: RatchetTree | null): Group;
  /**
   * Join a group using a Welcome (legacy API)
   */
  static join(provider: Provider, welcome: Uint8Array, ratchet_tree: RatchetTree): Group;
  /**
   * Load a group from the Provider's storage by CID
   *
   * After restoring a Provider from bytes (IndexedDB), call this to reopen
   * a group that was previously created or joined.
   *
   * # Arguments
   * * `provider` - Crypto provider (restored from bytes)
   * * `cid` - Channel ID (e.g., "team:channel_abc123")
   */
  static load(provider: Provider, cid: string): Group;
  /**
   * Add members and commit immediately (convenience method)
   *
   * Use this when you want to add members without batching.
   * For batch operations, use `propose_add_member` + `commit_pending_proposals`.
   */
  add_members(provider: Provider, sender: Identity, new_members: KeyPackage[]): CommitBundle;
  /**
   * Remove ALL devices of a user by user_id and commit immediately
   *
   * A user with N devices will have N leaf nodes in the group.
   * This method finds all of them and removes them in a single commit.
   */
  remove_user(provider: Provider, sender: Identity, user_id: string): CommitBundle;
  /**
   * Key rotation with immediate commit (convenience method)
   */
  self_update(provider: Provider, sender: Identity): CommitBundle;
  /**
   * Remove multiple users (all their devices) and commit immediately
   *
   * Each user_id may have multiple leaf nodes (devices).
   * This method finds ALL leaf nodes for ALL specified users
   * and removes them in a single commit.
   */
  remove_users(provider: Provider, sender: Identity, user_ids: string[]): CommitBundle;
  /**
   * Remove members and commit immediately (convenience method)
   */
  remove_members(provider: Provider, sender: Identity, member_indices: Uint32Array): CommitBundle;
  /**
   * Discard the pending commit (rollback)
   */
  clear_pending_commit(provider: Provider): void;
  /**
   * Merge the pending commit after DS confirmation
   */
  merge_pending_commit(provider: Provider): void;
  /**
   * Combined propose and commit for adding a single member
   * This is kept for backwards compatibility with demo code
   */
  propose_and_commit_add(provider: Provider, sender: Identity, new_member: KeyPackage): AddMessages;
  /**
   * Commit all pending proposals
   *
   * This creates a commit message that includes all queued proposals.
   * Use `merge_pending_commit` after the DS confirms the commit.
   */
  commit_pending_proposals(provider: Provider, sender: Identity): CommitBundle;
  /**
   * Add a user with multiple devices and commit immediately
   *
   * Each KeyPackage represents one device of the same user.
   * All devices are added in a single commit.
   */
  add_user(provider: Provider, sender: Identity, device_key_packages: KeyPackage[]): CommitBundle;
  /**
   * Export a secret key derived from the group state
   *
   * Useful for deriving encryption keys for media streams, etc.
   */
  export_key(provider: Provider, label: string, context: Uint8Array, key_length: number): Uint8Array;
  /**
   * Check if the group is in operational state
   *
   * Returns false if there's a pending commit or the group is inactive
   */
  is_operational(): boolean;
  /**
   * Get the local member's leaf index
   */
  own_leaf_index(): number;
  /**
   * Export group info for external commits
   *
   * # Arguments
   * * `with_ratchet_tree` - Whether to include the ratchet tree in the group info
   */
  export_group_info(provider: Provider, sender: Identity, with_ratchet_tree: boolean): Uint8Array;
  /**
   * Get a member by user_id (returns first match)
   */
  member_by_user_id(user_id: string): MemberInfo | undefined;
  /**
   * Check if there's a pending commit that hasn't been merged
   */
  has_pending_commit(): boolean;
  /**
   * Get ALL members (leaf nodes) for a given user_id
   *
   * A user with N devices will have N entries in the group.
   * Use this to find all leaf indices for a multi-device user.
   */
  members_by_user_id(user_id: string): MemberInfo[];
  /**
   * Export the ratchet tree for sharing with new members
   */
  export_ratchet_tree(): RatchetTree;
  /**
   * Get the CID (group_id as string)
   *
   * This returns the original cid string used to create the group,
   * matching the Ermis channel cid format (e.g., "team:channel_abc123")
   */
  cid(): string;
  /**
   * Get current epoch number
   *
   * Epoch increases with each commit
   */
  epoch(): bigint;
  /**
   * Get all members in the group
   */
  members(): MemberInfo[];
  /**
   * Get the raw group_id bytes
   */
  group_id(): Uint8Array;
  /**
   * Leave the group by creating a self-remove proposal
   *
   * Creates a Remove Proposal for the caller's own leaf node.
   * This proposal must be sent to the server and committed by another member.
   * The caller should NOT commit this proposal themselves.
   *
   * Returns the serialized proposal message bytes.
   */
  leave_group(provider: Provider, sender: Identity): Uint8Array;
  /**
   * Propose adding a user with multiple devices (does NOT commit immediately)
   *
   * Each KeyPackage represents one device. Creates one add proposal
   * per device, all queued as pending proposals.
   * Call `commit_pending_proposals` to batch them into a single commit.
   */
  propose_add_user(provider: Provider, sender: Identity, device_key_packages: KeyPackage[]): ProposalMessage[];
  /**
   * Propose adding a new member (does NOT commit immediately)
   *
   * Use this when you want to batch multiple proposals before committing.
   * Call `commit_pending_proposals` after queuing all proposals.
   */
  propose_add_member(provider: Provider, sender: Identity, new_member: KeyPackage): ProposalMessage;
  /**
   * Propose removing ALL devices of a user by user_id
   *
   * A user with N devices will have N leaf nodes. This creates
   * one remove proposal per device. Call `commit_pending_proposals`
   * after this to finalize all removals in a single commit.
   */
  propose_remove_user(provider: Provider, sender: Identity, user_id: string): ProposalMessage[];
  /**
   * Propose a self-update (key rotation for forward secrecy)
   */
  propose_self_update(provider: Provider, sender: Identity): ProposalMessage;
  /**
   * Propose removing a member by leaf index
   *
   * Use `member_by_user_id` to get the leaf index from a user_id.
   */
  propose_remove_member(provider: Provider, sender: Identity, member_index: number): ProposalMessage;
  /**
   * Clear all pending proposals without committing
   */
  clear_pending_proposals(provider: Provider): void;
  /**
   * Get the number of pending proposals
   */
  pending_proposals_count(): number;
  /**
   * Propose removing a member by user_id
   *
   * This is a convenience method that finds the member by credential
   * and proposes their removal.
   * Note: This only removes ONE leaf node. For multi-device users,
   * use `propose_remove_user` instead.
   */
  propose_remove_member_by_user_id(provider: Provider, sender: Identity, user_id: string): ProposalMessage;
  /**
   * Create an encrypted message
   *
   * # Arguments
   * * `provider` - Crypto provider
   * * `sender` - Identity of the sender
   * * `plaintext` - The message content to encrypt
   * 1
   * # Returns
   * Serialized encrypted MLS message
   */
  create_message(provider: Provider, sender: Identity, plaintext: Uint8Array): Uint8Array;
  /**
   * Process an incoming message (decrypt or handle proposal/commit)
   *
   * This method handles all MLS message types:
   * - ApplicationMessage: Returns decrypted content
   * - Proposal: Stores as pending proposal, returns empty content
   * - Commit: Merges the staged commit, returns empty content
   */
  process_message(provider: Provider, msg: Uint8Array): ProcessedMessage;
  /**
   * Process message and return raw bytes (legacy API, for backwards compatibility)
   *
   * Returns decrypted bytes for application messages, empty for proposals/commits.
   */
  process_message_raw(provider: Provider, msg: Uint8Array): Uint8Array;
  /**
   * Create an encrypted message with AAD in one call
   *
   * This is a convenience method that sets AAD and creates the message.
   *
   * # Arguments
   * * `provider` - Crypto provider
   * * `sender` - Identity of the sender
   * * `plaintext` - The message content to encrypt
   * * `aad` - Additional authenticated data (metadata to bind to ciphertext)
   */
  create_message_with_aad(provider: Provider, sender: Identity, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
  /**
   * Set Additional Authenticated Data (AAD) for the next outgoing message
   *
   * AAD is authenticated but NOT encrypted - use for metadata that needs
   * to be bound cryptographically to the ciphertext (e.g., sender_id, channel_id).
   * AAD is automatically reset after create_message() is called.
   *
   * # Arguments
   * * `aad` - Bytes to use as AAD (typically JSON-serialized metadata)
   */
  set_aad(aad: Uint8Array): void;
}
/**
 * Represents a user's MLS identity with credentials and signing keys
 */
export class Identity {
  free(): void;
  /**
   * Restore identity from bytes
   */
  static from_bytes(provider: Provider, bytes: Uint8Array): Identity;
  /**
   * Generate a single key package for this identity
   */
  key_package(provider: Provider): KeyPackage;
  /**
   * Generate multiple key packages for multi-device support
   *
   * # Arguments
   * * `provider` - The crypto provider
   * * `count` - Number of key packages to generate
   */
  key_packages(provider: Provider, count: number): KeyPackage[];
  /**
   * Create a new identity for a user
   *
   * # Arguments
   * * `provider` - The crypto provider
   * * `user_id` - Unique identifier for the user (e.g., from Ermis user system)
   */
  constructor(provider: Provider, user_id: string);
  /**
   * Serialize identity for storage
   * Note: This only exports the keypair, credential will be reconstructed
   */
  to_bytes(): Uint8Array;
  /**
   * Get the user_id from this identity
   */
  readonly user_id: string;
}
/**
 * A KeyPackage for joining groups
 */
export class KeyPackage {
  private constructor();
  free(): void;
  /**
   * Deserialize a KeyPackage from bytes
   */
  static from_bytes(bytes: Uint8Array): KeyPackage;
  /**
   * Get the hash reference of this key package
   */
  hash_ref(provider: Provider): Uint8Array;
  /**
   * Serialize this KeyPackage to bytes
   */
  to_bytes(): Uint8Array;
}
/**
 * Information about a group member
 */
export class MemberInfo {
  private constructor();
  free(): void;
  /**
   * Get the member's signature key
   */
  readonly signature_key: Uint8Array;
  /**
   * Get the member's encryption key
   */
  readonly encryption_key: Uint8Array;
  /**
   * Get the member's leaf index
   */
  readonly index: number;
  /**
   * Get the member's user_id
   */
  readonly user_id: string;
}
/**
 * Custom error type for MLS operations
 */
export class MlsError {
  free(): void;
  /**
   * Create a new MlsError
   */
  constructor(code: MlsErrorCode, message: string);
  /**
   * Get error code
   */
  readonly code: MlsErrorCode;
  /**
   * Get error message
   */
  readonly message: string;
}
/**
 * Result of processing an incoming message
 */
export class ProcessedMessage {
  private constructor();
  free(): void;
  /**
   * Check if this is a proposal
   */
  is_proposal(): boolean;
  /**
   * Check if this is an application message
   */
  is_application_message(): boolean;
  /**
   * Check if this is a commit
   */
  is_commit(): boolean;
  /**
   * Get the type of message
   */
  readonly message_type: MessageType;
  /**
   * Get the sender's leaf index
   */
  readonly sender_index: number;
  /**
   * Get the Additional Authenticated Data (AAD) from the message
   * This is the metadata that was bound to the ciphertext during encryption
   */
  readonly aad: Uint8Array;
  /**
   * Get the epoch this message belongs to
   */
  readonly epoch: bigint;
  /**
   * Get the decrypted content (only for ApplicationMessage)
   */
  readonly content: Uint8Array | undefined;
}
/**
 * A proposal message that can be sent to other group members
 */
export class ProposalMessage {
  private constructor();
  free(): void;
  /**
   * Get bytes as Uint8Array for JavaScript
   */
  bytes_as_uint8array(): Uint8Array;
  /**
   * Get the proposal reference for tracking
   */
  readonly proposal_ref: Uint8Array;
  /**
   * Get the serialized proposal message bytes
   */
  readonly bytes: Uint8Array;
}
/**
 * Crypto provider for MLS operations
 */
export class Provider {
  free(): void;
  /**
   * Restore a Provider from previously serialized bytes
   *
   * The crypto provider (RNG) is always fresh; only the key store
   * (private keys, group state, etc.) is restored from bytes.
   */
  static from_bytes(bytes: Uint8Array): Provider;
  constructor();
  /**
   * Serialize the key store to bytes for persistence (e.g. IndexedDB)
   *
   * Returns the serialized key store as a byte array.
   * Use `Provider.from_bytes()` to restore.
   */
  to_bytes(): Uint8Array;
}
/**
 * Ratchet tree for group state synchronization
 */
export class RatchetTree {
  private constructor();
  free(): void;
  /**
   * Deserialize a RatchetTree from bytes
   */
  static from_bytes(bytes: Uint8Array): RatchetTree;
  /**
   * Serialize this RatchetTree to bytes
   */
  to_bytes(): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_addmessages_free: (a: number, b: number) => void;
  readonly __wbg_commitbundle_free: (a: number, b: number) => void;
  readonly __wbg_externaljoinresult_free: (a: number, b: number) => void;
  readonly __wbg_group_free: (a: number, b: number) => void;
  readonly __wbg_mlserror_free: (a: number, b: number) => void;
  readonly __wbg_ratchettree_free: (a: number, b: number) => void;
  readonly addmessages_commit: (a: number) => any;
  readonly addmessages_group_info: (a: number) => [number, number];
  readonly addmessages_proposal: (a: number) => any;
  readonly addmessages_welcome: (a: number) => any;
  readonly commitbundle_commit: (a: number) => [number, number];
  readonly commitbundle_commit_as_uint8array: (a: number) => any;
  readonly commitbundle_group_info: (a: number) => [number, number];
  readonly commitbundle_has_welcome: (a: number) => number;
  readonly commitbundle_welcome: (a: number) => [number, number];
  readonly commitbundle_welcome_as_uint8array: (a: number) => any;
  readonly externaljoinresult_commit: (a: number) => [number, number];
  readonly externaljoinresult_group: (a: number) => number;
  readonly group_add_members: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly group_add_user: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly group_clear_pending_commit: (a: number, b: number) => [number, number];
  readonly group_commit_pending_proposals: (a: number, b: number, c: number) => [number, number, number];
  readonly group_create_new: (a: number, b: number, c: number, d: number) => number;
  readonly group_create_with_cid: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly group_join: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly group_join_external: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly group_join_with_welcome: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly group_load: (a: number, b: number, c: number) => [number, number, number];
  readonly group_merge_pending_commit: (a: number, b: number) => [number, number];
  readonly group_propose_and_commit_add: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly group_remove_members: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly group_remove_user: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly group_remove_users: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly group_save_state: (a: number, b: number) => [number, number];
  readonly group_self_update: (a: number, b: number, c: number) => [number, number, number];
  readonly mlserror_code: (a: number) => number;
  readonly mlserror_message: (a: number) => [number, number];
  readonly mlserror_new: (a: number, b: number, c: number) => number;
  readonly ratchettree_from_bytes: (a: number, b: number) => [number, number, number];
  readonly ratchettree_to_bytes: (a: number) => [number, number];
  readonly __wbg_identity_free: (a: number, b: number) => void;
  readonly __wbg_keypackage_free: (a: number, b: number) => void;
  readonly __wbg_memberinfo_free: (a: number, b: number) => void;
  readonly __wbg_processedmessage_free: (a: number, b: number) => void;
  readonly __wbg_proposalmessage_free: (a: number, b: number) => void;
  readonly __wbg_provider_free: (a: number, b: number) => void;
  readonly group_cid: (a: number) => [number, number, number, number];
  readonly group_clear_pending_proposals: (a: number, b: number) => [number, number];
  readonly group_create_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly group_create_message_with_aad: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
  readonly group_epoch: (a: number) => bigint;
  readonly group_export_group_info: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly group_export_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
  readonly group_export_ratchet_tree: (a: number) => number;
  readonly group_group_id: (a: number) => [number, number];
  readonly group_has_pending_commit: (a: number) => number;
  readonly group_is_operational: (a: number) => number;
  readonly group_leave_group: (a: number, b: number, c: number) => [number, number, number, number];
  readonly group_member_by_user_id: (a: number, b: number, c: number) => number;
  readonly group_members: (a: number) => [number, number];
  readonly group_members_by_user_id: (a: number, b: number, c: number) => [number, number];
  readonly group_own_leaf_index: (a: number) => number;
  readonly group_pending_proposals_count: (a: number) => number;
  readonly group_process_message: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly group_process_message_raw: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly group_propose_add_member: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly group_propose_add_user: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly group_propose_remove_member: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly group_propose_remove_member_by_user_id: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly group_propose_remove_user: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly group_propose_self_update: (a: number, b: number, c: number) => [number, number, number];
  readonly group_set_aad: (a: number, b: number, c: number) => void;
  readonly hash_channel_id: (a: number, b: number, c: number, d: number) => [number, number];
  readonly identity_from_bytes: (a: number, b: number, c: number) => [number, number, number];
  readonly identity_key_package: (a: number, b: number) => number;
  readonly identity_key_packages: (a: number, b: number, c: number) => [number, number];
  readonly identity_new: (a: number, b: number, c: number) => [number, number, number];
  readonly identity_to_bytes: (a: number) => [number, number, number, number];
  readonly identity_user_id: (a: number) => [number, number];
  readonly keypackage_from_bytes: (a: number, b: number) => [number, number, number];
  readonly keypackage_hash_ref: (a: number, b: number) => [number, number, number, number];
  readonly keypackage_to_bytes: (a: number) => [number, number];
  readonly memberinfo_encryption_key: (a: number) => [number, number];
  readonly memberinfo_index: (a: number) => number;
  readonly memberinfo_signature_key: (a: number) => [number, number];
  readonly memberinfo_user_id: (a: number) => [number, number];
  readonly processedmessage_aad: (a: number) => [number, number];
  readonly processedmessage_content: (a: number) => [number, number];
  readonly processedmessage_epoch: (a: number) => bigint;
  readonly processedmessage_is_application_message: (a: number) => number;
  readonly processedmessage_is_commit: (a: number) => number;
  readonly processedmessage_is_proposal: (a: number) => number;
  readonly processedmessage_message_type: (a: number) => number;
  readonly processedmessage_sender_index: (a: number) => number;
  readonly proposalmessage_bytes: (a: number) => [number, number];
  readonly proposalmessage_bytes_as_uint8array: (a: number) => any;
  readonly proposalmessage_proposal_ref: (a: number) => [number, number];
  readonly provider_from_bytes: (a: number, b: number) => [number, number, number];
  readonly provider_new: () => number;
  readonly provider_to_bytes: (a: number) => [number, number, number, number];
  readonly validate_key_package_bytes: (a: number, b: number) => number;
  readonly init: () => void;
  readonly greet: () => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
