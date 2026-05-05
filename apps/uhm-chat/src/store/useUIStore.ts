import { create } from 'zustand';
import type { Channel as ChannelType } from '@ermis-network/ermis-chat-sdk';

interface UIState {
  isCreateChannelModalOpen: boolean;
  openCreateChannelModal: () => void;
  closeCreateChannelModal: () => void;
  toggleCreateChannelModal: () => void;

  // Topic Modal State
  topicAction: { type: 'create' | 'edit' | null; channel: ChannelType | null };
  openCreateTopicModal: (parentChannel: ChannelType) => void;
  openEditTopicModal: (topic: ChannelType) => void;
  closeTopicModal: () => void;

  // Global Pickers State
  pickerAction: { 
    type: 'emoji' | 'sticker' | null; 
    anchorRect: DOMRect | null;
    onSelect?: (data: any) => void;
  };
  openEmojiPicker: (anchorRect: DOMRect, onSelect: (emoji: any) => void) => void;
  openStickerPicker: (anchorRect: DOMRect, onSelect: (sticker: any) => void) => void;
  closePickers: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  isCreateChannelModalOpen: false,
  openCreateChannelModal: () => set({ isCreateChannelModalOpen: true }),
  closeCreateChannelModal: () => set({ isCreateChannelModalOpen: false }),
  toggleCreateChannelModal: () => set((state) => ({ isCreateChannelModalOpen: !state.isCreateChannelModalOpen })),

  topicAction: { type: null, channel: null },
  openCreateTopicModal: (parentChannel) => set({ topicAction: { type: 'create', channel: parentChannel } }),
  openEditTopicModal: (topic) => set({ topicAction: { type: 'edit', channel: topic } }),
  closeTopicModal: () => set({ topicAction: { type: null, channel: null } }),

  pickerAction: { type: null, anchorRect: null },
  openEmojiPicker: (anchorRect, onSelect) => set({ pickerAction: { type: 'emoji', anchorRect, onSelect } }),
  openStickerPicker: (anchorRect, onSelect) => set({ pickerAction: { type: 'sticker', anchorRect, onSelect } }),
  closePickers: () => set({ pickerAction: { type: null, anchorRect: null } }),
}));
