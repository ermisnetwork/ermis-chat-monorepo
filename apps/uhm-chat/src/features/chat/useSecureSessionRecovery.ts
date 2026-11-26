import { useCallback, useSyncExternalStore } from 'react';
import type { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import { hasSecureSessionIssue, scopedRecoveryPresentation } from './secureSessionNotice';

export function useSecureSessionRecovery(client: ErmisChat, channelCid: string, scopeCid: string, indicator: true): boolean;
export function useSecureSessionRecovery(client: ErmisChat, channelCid: string, scopeCid: string, indicator?: false): ReturnType<typeof scopedRecoveryPresentation>;
export function useSecureSessionRecovery(client: ErmisChat, channelCid: string, scopeCid: string, indicator = false) {
  const user = client.userID;
  const subscribe = useCallback((changed: () => void) => {
    const notify = (event: { cid?: string }) => {
      if (client.userID === user && (!event.cid || event.cid === scopeCid || event.cid === channelCid)) changed();
    };
    const subscriptions = [
      client.on('e2ee.recovery_presentation_changed', notify),
      client.on('e2ee.session_progress', notify),
      client.on('e2ee.state_changed', notify),
      client.on('e2ee.initialized', notify),
      client.on('channel.updated', notify),
      client.on('member.removed', notify),
    ];
    return () => subscriptions.forEach(subscription => subscription.unsubscribe());
  }, [client, user, channelCid, scopeCid]);
  const read = useCallback(() => {
    const manager = client.encryptionManager;
    if (!manager?.initialized || manager.userId !== user || !scopeCid) return indicator ? false : undefined;
    const readiness = client.getChannelSessionReadiness(channelCid);
    const observed = manager.getMlsRecoveryPresentation(scopeCid);
    return indicator ? hasSecureSessionIssue(observed, readiness) : scopedRecoveryPresentation(observed, readiness);
  }, [client, user, channelCid, scopeCid, indicator]);
  return useSyncExternalStore(subscribe, read);
}
