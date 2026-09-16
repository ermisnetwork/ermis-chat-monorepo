import type {
  EncryptionStorageAdapter,
  EventCursor,
  ExternalJoinReadinessState,
  GetKeyPackagesByCidResponse,
  MlsGroupGenerationMarker,
} from './types';

export const NO_MATCHING_KEY_PACKAGE = 'NoMatchingKeyPackage' as const;
export const ACTIVE_MEMBER_RECOVERY = 'active_member_recovery' as const;

export class WelcomeJoinFailure extends Error {
  readonly code = NO_MATCHING_KEY_PACKAGE;

  constructor(message = 'The Welcome does not contain a KeyPackage owned by this device') {
    super(message);
    this.name = 'WelcomeJoinFailure';
  }
}

export function isNoMatchingKeyPackageFailure(error: unknown): error is WelcomeJoinFailure {
  return (
    error instanceof WelcomeJoinFailure ||
    (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === NO_MATCHING_KEY_PACKAGE)
  );
}

export function selectedWelcomeLeaves(
  response: Pick<GetKeyPackagesByCidResponse, 'members'>,
): Array<{ userId: string; deviceId: string; keyPackage: Uint8Array }> {
  return response.members.flatMap((member) =>
    member.key_packages.map((item) => ({
      userId: member.user_id,
      deviceId: item.device_id,
      keyPackage: item.key_package,
    })),
  );
}

type ExternalJoinResult = {
  epoch: number;
  status?: string;
};

/**
 * Device-local external-join prerequisite state machine. A typed Welcome
 * NoMatchingKeyPackage result opens the partial-Welcome lane. A separately
 * typed active-member server response opens recovery when no Welcome remains.
 */
export class PartialWelcomeJoinCoordinator {
  private readonly states = new Map<string, ExternalJoinReadinessState>();
  private readonly inFlight = new Map<string, Promise<ExternalJoinResult>>();

  constructor(private readonly storage: EncryptionStorageAdapter) {}

  async getState(cid: string): Promise<ExternalJoinReadinessState | null> {
    const cached = this.states.get(cid);
    if (cached) return cached;
    const stored = (await this.storage.loadExternalJoinReadiness(cid)) || null;
    if (stored) this.states.set(cid, stored);
    return stored;
  }

  async recordWelcomeFailure(
    cid: string,
    error: unknown,
    welcomeEpoch?: number,
    welcomeEventCursor?: EventCursor,
  ): Promise<boolean> {
    if (!isNoMatchingKeyPackageFailure(error)) return false;
    const state: ExternalJoinReadinessState = {
      cid,
      status: 'pending_external_join',
      reason: NO_MATCHING_KEY_PACKAGE,
      welcome_epoch: welcomeEpoch,
      welcome_event_cursor: welcomeEventCursor,
      updated_at: Date.now(),
    };
    await this.storage.saveExternalJoinReadiness(state);
    this.states.set(cid, state);
    return true;
  }

  async recordActiveMemberRecovery(cid: string, prerequisite: unknown): Promise<boolean> {
    if (
      typeof prerequisite !== 'object' ||
      prerequisite === null ||
      (prerequisite as { reason?: unknown }).reason !== ACTIVE_MEMBER_RECOVERY
    ) {
      return false;
    }
    const state: ExternalJoinReadinessState = {
      cid,
      status: 'pending_external_join',
      reason: ACTIVE_MEMBER_RECOVERY,
      updated_at: Date.now(),
    };
    await this.storage.saveExternalJoinReadiness(state);
    this.states.set(cid, state);
    return true;
  }

  async clearAfterWelcome(cid: string): Promise<void> {
    await this.storage.deleteExternalJoinReadiness(cid);
    this.states.delete(cid);
  }

  async persistWelcomeJoin(
    cid: string,
    userId: string,
    deviceId: string,
    providerBytes: Uint8Array,
    generation?: MlsGroupGenerationMarker,
  ): Promise<void> {
    await this.storage.saveJoinCheckpoint({
      user_id: userId,
      device_id: deviceId,
      provider_bytes: providerBytes,
      cid,
      readiness: null,
      generation,
    });
    this.states.delete(cid);
  }

  async persistExternalJoin(
    cid: string,
    epoch: number,
    userId: string,
    deviceId: string,
    providerBytes: Uint8Array,
    generation?: MlsGroupGenerationMarker,
  ): Promise<ExternalJoinReadinessState> {
    const prior = await this.getState(cid);
    const joined: ExternalJoinReadinessState = {
      cid,
      status: 'joined_external',
      reason: prior?.reason || 'manual_external_join',
      welcome_epoch: prior?.welcome_epoch,
      welcome_event_cursor: prior?.welcome_event_cursor,
      first_decryptable_epoch: epoch,
      updated_at: Date.now(),
    };
    await this.storage.saveJoinCheckpoint({
      user_id: userId,
      device_id: deviceId,
      provider_bytes: providerBytes,
      cid,
      readiness: joined,
      generation,
    });
    this.states.set(cid, joined);
    return joined;
  }

  async runExternalJoin<T extends ExternalJoinResult>(cid: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(cid);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve().then(work);
    this.inFlight.set(cid, promise);
    try {
      return (await promise) as T;
    } finally {
      if (this.inFlight.get(cid) === promise) this.inFlight.delete(cid);
    }
  }

  async isPreJoinHistorical(cid: string, messageEpoch?: number): Promise<boolean> {
    if (messageEpoch === undefined) return false;
    const state = await this.getState(cid);
    return (
      state?.status === 'joined_external' &&
      state.first_decryptable_epoch !== undefined &&
      messageEpoch < state.first_decryptable_epoch
    );
  }
}
