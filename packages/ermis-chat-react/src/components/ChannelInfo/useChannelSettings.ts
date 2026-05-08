import { useState, useEffect, useCallback } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';

export interface UseChannelSettingsOptions {
  channel: Channel | undefined;
  isOpen?: boolean;
  onClose?: () => void;
  currentUserRole?: string;
}

export const useChannelSettings = ({ channel, isOpen, onClose, currentUserRole }: UseChannelSettingsOptions) => {
  const [slowMode, setSlowMode] = useState<number>(0);
  const [topicsEnabled, setTopicsEnabled] = useState<boolean>(false);
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({
    'send-message': true,
    'send-links': true,
    'update-own-message': true,
    'delete-own-message': true,
    'send-reaction': true,
    'pin-message': true,
    'create-poll': true,
    'vote-poll': true,
  });

  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwner = currentUserRole === 'owner';

  // Sync state when panel opens or channel updates
  useEffect(() => {
    if (!channel) return;

    const syncData = (dataToSync = channel.data) => {
      setSlowMode((dataToSync?.member_message_cooldown as number) || 0);
      setKeywords((dataToSync?.filter_words as string[]) || []);
      setTopicsEnabled(dataToSync?.topics_enabled === true);

      const caps = dataToSync?.member_capabilities as string[] || [];
      setCapabilities({
        'send-message': caps.includes('send-message'),
        'send-links': caps.includes('send-links'),
        'update-own-message': caps.includes('update-own-message'),
        'delete-own-message': caps.includes('delete-own-message'),
        'send-reaction': caps.includes('send-reaction'),
        'pin-message': caps.includes('pin-message'),
        'create-poll': caps.includes('create-poll'),
        'vote-poll': caps.includes('vote-poll'),
      });
      setError(null);
    };

    if (isOpen) {
      syncData();
    }

    // Listen to real-time changes
    const subscription = channel.on('channel.updated', (event: any) => {
      const latestData = event?.channel || channel.data;
      // Force mutating local channel.data to ensure future syncData hits cache
      if (event?.channel && channel.data) {
        Object.assign(channel.data, event.channel);
      }

      if (isOpen) {
        syncData(latestData);
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, [isOpen, channel]);

  const toggleCapability = useCallback((key: string) => {
    setCapabilities(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Compute dirty state
  const isSlowModeChanged = slowMode !== ((channel?.data?.member_message_cooldown as number) || 0);
  const isTopicsChanged = topicsEnabled !== (channel?.data?.topics_enabled === true);

  const currentKeywordsSorted = [...keywords].sort().join(',');
  const originalKeywordsSorted = [...((channel?.data?.filter_words as string[]) || [])].sort().join(',');
  const isKeywordsChanged = currentKeywordsSorted !== originalKeywordsSorted;

  const originalCapabilities = channel?.data?.member_capabilities as string[] || [];
  const initialCapabilities: Record<string, boolean> = {
    'send-message': originalCapabilities.includes('send-message'),
    'send-links': originalCapabilities.includes('send-links'),
    'update-own-message': originalCapabilities.includes('update-own-message'),
    'delete-own-message': originalCapabilities.includes('delete-own-message'),
    'send-reaction': originalCapabilities.includes('send-reaction'),
    'pin-message': originalCapabilities.includes('pin-message'),
    'create-poll': originalCapabilities.includes('create-poll'),
    'vote-poll': originalCapabilities.includes('vote-poll'),
  };
  const isCapabilitiesChanged = Object.keys(capabilities).some(k => capabilities[k] !== initialCapabilities[k]);

  const isDirty = isSlowModeChanged || isKeywordsChanged || isCapabilitiesChanged || isTopicsChanged;

  const handleAddNewKeyword = useCallback(() => {
    if (newKeyword.trim()) {
      const keyword = newKeyword.trim().toLowerCase();
      if (!keywords.includes(keyword)) {
        setKeywords(prev => [...prev, keyword]);
      }
      setNewKeyword('');
    }
  }, [newKeyword, keywords]);

  const handleRemoveKeyword = useCallback((kw: string) => {
    setKeywords(prev => prev.filter(k => k !== kw));
  }, []);

  const handleSave = useCallback(async () => {
    if (!channel) return;
    setIsSaving(true);
    setError(null);
    try {
      const dataUpdates: any = {};
      let capabilitiesArray: string[] | null = null;

      if (isSlowModeChanged) {
        dataUpdates.member_message_cooldown = slowMode;
      }

      if (isKeywordsChanged) {
        dataUpdates.filter_words = keywords;
      }

      if (isCapabilitiesChanged) {
        const controlledKeys = Object.keys(capabilities);
        const originalCaps = (channel.data?.member_capabilities as string[]) || [];

        // Preserve unmanaged original capabilities
        const unmanagedCaps = originalCaps.filter(c => !controlledKeys.includes(c));

        // Extract managed capabilities that are currently enabled
        const managedEnabledCaps = controlledKeys.filter(k => capabilities[k as keyof typeof capabilities]);

        // Merge into the final payload array
        capabilitiesArray = [...unmanagedCaps, ...managedEnabledCaps];
      }

      if (Object.keys(dataUpdates).length > 0 || capabilitiesArray !== null) {
        const payload: any = {};

        if (Object.keys(dataUpdates).length > 0) {
          payload.data = dataUpdates;
          if (channel.data) Object.assign(channel.data, dataUpdates);
        }

        if (capabilitiesArray !== null) {
          payload.capabilities = capabilitiesArray;
          if (channel.data) {
            channel.data.member_capabilities = capabilitiesArray;
          }
        }

        // Use _update instead of update to safely construct root-level payloads
        await (channel as any)._update(payload);
      }

      if (isTopicsChanged) {
        if (topicsEnabled) {
          await channel.enableTopics();
        } else {
          await channel.disableTopics();
        }
      }

      if (onClose) onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to update settings');
    } finally {
      setIsSaving(false);
    }
  }, [
    channel,
    isSlowModeChanged,
    slowMode,
    isKeywordsChanged,
    keywords,
    isCapabilitiesChanged,
    capabilities,
    isTopicsChanged,
    topicsEnabled,
    onClose,
  ]);

  return {
    slowMode,
    setSlowMode,
    topicsEnabled,
    setTopicsEnabled,
    capabilities,
    toggleCapability,
    keywords,
    newKeyword,
    setNewKeyword,
    handleAddNewKeyword,
    handleRemoveKeyword,
    isSaving,
    error,
    isDirty,
    isOwner,
    handleSave,
  };
};
