import React, { useState, useMemo, useCallback } from 'react';
import { Modal as DefaultModal } from '../Modal';
import { UserPicker } from '../UserPicker';
import { Avatar } from '../Avatar';
import { useChatComponents } from '../../context/ChatComponentsContext';
import type { AddMemberModalProps, UserPickerUser } from '../../types';

export const AddMemberModal: React.FC<AddMemberModalProps> = ({
  channel,
  currentMembers,
  onClose,
  AvatarComponent = Avatar,
  title = 'Add Member',
  searchPlaceholder = 'Search by name, email or phone...',
  loadingText = 'Loading users...',
  emptyText = 'No users found.',
  addLabel = 'Add',
  addingLabel = 'Adding...',
  addedLabel = 'Added',
  UserItemComponent,
  SearchInputComponent,
}) => {
  const { ModalComponent } = useChatComponents();
  const Modal = ModalComponent || DefaultModal;
  const [selectedUsers, setSelectedUsers] = useState<UserPickerUser[]>([]);
  const [isAdding, setIsAdding] = useState(false);

  // Exclude existing members from the picker
  const excludeUserIds = useMemo(
    () => currentMembers.map((m: any) => m.user_id),
    [currentMembers],
  );


  const handleSelectionChange = useCallback((users: UserPickerUser[]) => {
    setSelectedUsers(users);
  }, []);

  const handleAdd = useCallback(async () => {
    if (selectedUsers.length === 0 || isAdding) return;
    try {
      setIsAdding(true);
      await channel.addMembers(selectedUsers.map(u => u.id));
      onClose();
    } catch (err) {
      console.error('Failed to add members:', err);
    } finally {
      setIsAdding(false);
    }
  }, [selectedUsers, isAdding, channel, onClose]);

  const footer = (
    <button
      className="ermis-modal-add-btn"
      onClick={handleAdd}
      disabled={selectedUsers.length === 0 || isAdding}
    >
      {isAdding
        ? addingLabel
        : `${addLabel} ${selectedUsers.length > 0 ? `(${selectedUsers.length})` : ''}`}
    </button>
  );

  return (
    <Modal isOpen onClose={onClose} title={title} maxWidth="480px" footer={footer}>
      <UserPicker
        mode="checkbox"
        onSelectionChange={handleSelectionChange}
        excludeUserIds={excludeUserIds}
        pageSize={30}
        AvatarComponent={AvatarComponent}
        UserItemComponent={UserItemComponent as any}
        SearchInputComponent={SearchInputComponent}
        searchPlaceholder={searchPlaceholder}
        loadingText={loadingText}
        emptyText={emptyText}
        selectedEmptyLabel="Select users to add..."
      />
    </Modal>
  );
};
