import React, { useState, useMemo, useCallback } from 'react';
import { Modal as DefaultModal } from './Modal';
import { UserPicker } from './UserPicker';
import { Avatar } from './Avatar';
import { useChatClient } from '../hooks/useChatClient';
import { useChatComponents } from '../context/ChatComponentsContext';
import type { CreateChannelModalProps, UserPickerUser } from '../types';
import { isDirectChannel } from '../channelTypeUtils';


export const CreateChannelModal: React.FC<CreateChannelModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  AvatarComponent = Avatar,
  UserItemComponent,
  title = 'New Message',
  directTabLabel = 'Direct',
  groupTabLabel = 'Group',
  groupNameLabel = 'Channel Name',
  groupNamePlaceholder = 'Enter channel name (required)',
  groupDescriptionLabel = 'Description',
  groupDescriptionPlaceholder = 'Optional description',
  groupPublicLabel = 'Public Channel',
  userSearchPlaceholder = 'Search users...',
  cancelButtonLabel = 'Cancel',
  createButtonLabel = 'Create',
  creatingButtonLabel = 'Creating...',
  messageButtonLabel = 'Message',
  TabsComponent,
  FooterComponent,
  GroupFieldsComponent,
  SearchInputComponent,
  SelectedBoxComponent,
}) => {
  const { client, setActiveChannel } = useChatClient();
  const { ModalComponent } = useChatComponents();
  const Modal = ModalComponent || DefaultModal;
  const currentUserId = client?.userID;

  /* ---------- State ---------- */
  const [tab, setTab] = useState<'messaging' | 'team'>('messaging');
  const [step, setStep] = useState<1 | 2>(1); // Only for team channel

  // Group specific
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);

  // Users
  const [selectedUsers, setSelectedUsers] = useState<UserPickerUser[]>([]);

  // Progress/Error
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ---------- Exclude IDs for Direct ---------- */
  const hasExistingDirectChannel = useMemo(() => {
    if (!client || !currentUserId || tab !== 'messaging' || selectedUsers.length === 0) return false;
    const targetUserId = selectedUsers[0].id;

    return Object.values(client.activeChannels).some((ch: any) => {
      if (isDirectChannel(ch) && ch.state?.members) {
        const membersList = Object.keys(ch.state.members);
        return membersList.length === 2 &&
          membersList.includes(currentUserId) &&
          membersList.includes(targetUserId);
      }
      return false;
    });
  }, [client, currentUserId, tab, selectedUsers]);

  /* ---------- Handlers ---------- */
  const handleCreate = useCallback(async () => {
    if (!client || !currentUserId || isCreating) return;

    // Validations
    if (selectedUsers.length === 0) {
      setError('Please select at least one user.');
      return;
    }

    if (tab === 'team' && !name.trim()) {
      setError('Group name is required.');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      let createdChannel;

      if (tab === 'messaging') {
        const targetUserId = selectedUsers[0].id;

        // Try to find an existing direct channel locally
        const existingChannel = Object.values(client.activeChannels).find((ch: any) => {
          if (isDirectChannel(ch) && ch.state?.members) {
            const membersList = Object.keys(ch.state.members);
            return membersList.length === 2 &&
              membersList.includes(currentUserId) &&
              membersList.includes(targetUserId);
          }
          return false;
        });

        if (existingChannel) {
          if (setActiveChannel) setActiveChannel(existingChannel as any);
          if (onSuccess) {
            onSuccess(existingChannel as any);
          } else {
            onClose();
          }
          setIsCreating(false);
          return;
        }

        createdChannel = client.channel('messaging', {
          members: [currentUserId, targetUserId],
        } as any);
        const response = (await createdChannel.create()) as any;
        if (response?.channel?.id) {
          createdChannel = client.channel('messaging', response.channel.id);
          await createdChannel.watch();
        }
      } else {
        // Group Channel
        const memberIds = selectedUsers.map(member => member.id);
        // Ensure current user is in the group members
        if (!memberIds.includes(currentUserId)) {
          memberIds.push(currentUserId);
        }

        const payload: any = {
          name: name.trim(),
          members: memberIds,
          public: isPublic,
        };

        if (description.trim()) {
          payload.description = description.trim();
        }

        createdChannel = client.channel('team', payload);
        const response = (await createdChannel.create()) as any;
        if (response?.channel?.id) {
          createdChannel = client.channel('team', response.channel.id);
          await createdChannel.watch();
        }
      }

      if (setActiveChannel) {
        setActiveChannel(createdChannel);
      }

      // Cleanup and execute callback
      if (onSuccess) {
        onSuccess(createdChannel);
      } else {
        onClose();
      }

    } catch (err: any) {
      setError(err?.message || 'Failed to create channel');
    } finally {
      setIsCreating(false);
    }
  }, [client, currentUserId, isCreating, selectedUsers, tab, name, isPublic, description, onSuccess, onClose]);


  const isValid = useMemo(() => {
    if (tab === 'messaging' && selectedUsers.length === 0) return false;
    if (tab === 'team' && step === 1 && !name.trim()) return false;
    if (tab === 'team' && step === 2 && selectedUsers.length === 0) return false;
    return true;
  }, [selectedUsers, tab, name, step]);

  let footer;
  if (FooterComponent) {
    footer = (
      <FooterComponent
        tab={tab}
        step={step}
        onCancel={() => {
          if (tab === 'team' && step === 2) {
            setError(null);
            setStep(1);
          } else {
            onClose();
          }
        }}
        onNext={() => {
          setError(null);
          setStep(2);
        }}
        onBack={() => {
          setError(null);
          setStep(1);
        }}
        onCreate={handleCreate}
        isCreating={isCreating}
        isValid={isValid}
        hasExistingDirectChannel={hasExistingDirectChannel}
        cancelButtonLabel={cancelButtonLabel}
        createButtonLabel={createButtonLabel}
        creatingButtonLabel={creatingButtonLabel}
        messageButtonLabel={messageButtonLabel}
      />
    );
  } else if (tab === 'messaging') {
    footer = (
      <div className="ermis-create-channel__footer">
        <button className="ermis-create-channel__btn ermis-create-channel__btn--cancel" onClick={onClose} disabled={isCreating}>{cancelButtonLabel}</button>
        <button className="ermis-create-channel__btn ermis-create-channel__btn--create" onClick={handleCreate} disabled={isCreating || !isValid}>
          {isCreating ? creatingButtonLabel : (hasExistingDirectChannel ? messageButtonLabel : createButtonLabel)}
        </button>
      </div>
    );
  } else if (tab === 'team' && step === 1) {
    footer = (
      <div className="ermis-create-channel__footer">
        <button className="ermis-create-channel__btn ermis-create-channel__btn--cancel" onClick={onClose} disabled={isCreating}>{cancelButtonLabel}</button>
        <button className="ermis-create-channel__btn ermis-create-channel__btn--create" onClick={() => { setError(null); setStep(2); }} disabled={isCreating || !isValid}>
          Next
        </button>
      </div>
    );
  } else if (tab === 'team' && step === 2) {
    footer = (
      <div className="ermis-create-channel__footer">
        <button className="ermis-create-channel__btn ermis-create-channel__btn--cancel" onClick={() => { setError(null); setStep(1); }} disabled={isCreating}>Back</button>
        <button className="ermis-create-channel__btn ermis-create-channel__btn--create" onClick={handleCreate} disabled={isCreating || !isValid}>
          {isCreating ? creatingButtonLabel : createButtonLabel}
        </button>
      </div>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={isCreating ? () => { } : onClose} title={title} maxWidth="480px" footer={footer}>
      <div className="ermis-create-channel__body">

        {/* Type Toggle */}
        {TabsComponent ? (
          <TabsComponent
            activeTab={tab}
            onTabChange={(t) => {
              setTab(t);
              setStep(1);
              setSelectedUsers([]);
              setError(null);
            }}
            disabled={isCreating}
            directTabLabel={directTabLabel}
            groupTabLabel={groupTabLabel}
          />
        ) : (
          <div className="ermis-create-channel__tabs">
            <button
              className={`ermis-create-channel__tab ${tab === 'messaging' ? 'ermis-create-channel__tab--active' : ''}`}
              onClick={() => {
                setTab('messaging');
                setStep(1);
                setSelectedUsers([]);
                setError(null);
              }}
              disabled={isCreating}
            >
              {directTabLabel}
            </button>
            <button
              className={`ermis-create-channel__tab ${tab === 'team' ? 'ermis-create-channel__tab--active' : ''}`}
              onClick={() => {
                setTab('team');
                setStep(1);
                setSelectedUsers([]);
                setError(null);
              }}
              disabled={isCreating}
            >
              {groupTabLabel}
            </button>
          </div>
        )}

        {/* Group Specific Fields - Step 1 */}
        {tab === 'team' && step === 1 && (
          GroupFieldsComponent ? (
            <GroupFieldsComponent
              name={name}
              onNameChange={setName}
              description={description}
              onDescriptionChange={setDescription}
              isPublic={isPublic}
              onPublicChange={setIsPublic}
              disabled={isCreating}
              groupNameLabel={groupNameLabel}
              groupNamePlaceholder={groupNamePlaceholder}
              groupDescriptionLabel={groupDescriptionLabel}
              groupDescriptionPlaceholder={groupDescriptionPlaceholder}
              groupPublicLabel={groupPublicLabel}
            />
          ) : (
            <>
              <div className="ermis-create-channel__field">
                <label className="ermis-create-channel__label">{groupNameLabel} <span style={{ color: 'var(--ermis-error)' }}>*</span></label>
                <input
                  className="ermis-create-channel__input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={groupNamePlaceholder}
                  disabled={isCreating}
                  maxLength={100}
                />
              </div>

              <div className="ermis-create-channel__field">
                <label className="ermis-create-channel__label">{groupDescriptionLabel}</label>
                <textarea
                  className="ermis-create-channel__textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={groupDescriptionPlaceholder}
                  disabled={isCreating}
                  maxLength={500}
                  rows={2}
                />
              </div>

              <div className="ermis-create-channel__field ermis-create-channel__field--toggle">
                <label className="ermis-create-channel__label">{groupPublicLabel}</label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPublic}
                  className={`ermis-create-channel__toggle ${isPublic ? 'ermis-create-channel__toggle--on' : ''}`}
                  onClick={() => setIsPublic(v => !v)}
                  disabled={isCreating}
                >
                  <span className="ermis-create-channel__toggle-thumb" />
                </button>
              </div>
            </>
          )
        )}

        {/* User Selection - Step 2 (Group) or Step 1 (Messaging) */}
        {((tab === 'team' && step === 2) || tab === 'messaging') && (
          <div className={`ermis-create-channel__users ermis-create-channel__users--${tab}`}>
            <UserPicker
              mode={tab === 'messaging' ? 'radio' : 'checkbox'}
              onSelectionChange={setSelectedUsers}
              initialSelectedUsers={selectedUsers}
              AvatarComponent={AvatarComponent}
              UserItemComponent={UserItemComponent as any}
              SearchInputComponent={SearchInputComponent as any}
              SelectedBoxComponent={SelectedBoxComponent as any}
              searchPlaceholder={userSearchPlaceholder}
            />
          </div>
        )}

        {error && (
          <div className="ermis-create-channel__error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

      </div>
    </Modal>
  );
};
