import { create } from 'zustand';

interface UIState {
  isCreateChannelModalOpen: boolean;
  openCreateChannelModal: () => void;
  closeCreateChannelModal: () => void;
  toggleCreateChannelModal: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  isCreateChannelModalOpen: false,
  openCreateChannelModal: () => set({ isCreateChannelModalOpen: true }),
  closeCreateChannelModal: () => set({ isCreateChannelModalOpen: false }),
  toggleCreateChannelModal: () => set((state) => ({ isCreateChannelModalOpen: !state.isCreateChannelModalOpen })),
}));
