import React, { useState, useMemo, useCallback } from 'react';
import { Modal as DefaultModal } from './Modal';
import { UserPicker } from './UserPicker';
import { Avatar } from './Avatar';
import { useChatClient } from '../hooks/useChatClient';
import { useChatComponents } from '../context/ChatComponentsContext';
import { markChannelAsFullyQueried } from '../hooks/useChannelMessages';
import type { CreateChannelE2eeToggleProps, CreateChannelModalProps, UserPickerUser } from '../types';
import { isDirectChannel } from '../channelTypeUtils';

const DefaultE2eeToggle: React.FC<CreateChannelE2eeToggleProps> = ({
  enabled,
  onChange,
  disabled,
  label = 'End-to-end encrypted',
  description,
}) => (
  <div className="ermis-create-channel__field ermis-create-channel__field--toggle">
    <div>
      <label className="ermis-create-channel__label">{label}</label>
      {description && <div className="ermis-create-channel__hint">{description}</div>}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`ermis-create-channel__toggle ${enabled ? 'ermis-create-channel__toggle--on' : ''}`}
      onClick={() => onChange(!enabled)}
      disabled={disabled}
    >
      <span className="ermis-create-channel__toggle-thumb" />
    </button>
  </div>
);

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
  nextButtonLabel = 'Next',
  backButtonLabel = 'Back',
  emptyStateLabel = 'No users found',
  e2eeLabel = 'End-to-end encrypted',
  e2eeDescription = 'Only channel members can read encrypted messages.',
  e2eeUnavailableLabel = 'E2EE is unavailable on this device.',
  TabsComponent,
  FooterComponent,
  GroupFieldsComponent,
  SearchInputComponent,
  SelectedBoxComponent,
  E2eeToggleComponent = DefaultE2eeToggle,
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
  const [e2eeEnabled, setE2eeEnabled] = useState(false);

  // Users
  const [selectedUsers, setSelectedUsers] = useState<UserPickerUser[]>([]);

  // Progress/Error
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const e2eeAvailable = Boolean(client?.mlsManager?.initialized);

  const handleE2eeChange = useCallback((enabled: boolean) => {
    setE2eeEnabled(enabled);
    if (enabled) setIsPublic(false);
  }, []);

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

        const members = [currentUserId, targetUserId];
        const payload: Record<string, any> = { members };

        if (e2eeEnabled) {
          const mlsManager = client.mlsManager;
          if (!mlsManager?.initialized) {
            throw new Error(e2eeUnavailableLabel);
          }
          const bundle = await mlsManager.createE2eeChannel('messaging', null, null, members);
          Object.assign(payload, {
            mls_enabled: true,
            channel_id: bundle.channel_id,
            ...bundle,
          });
        }

        createdChannel = client.channel('messaging', payload as any);
        const response = (await createdChannel.create()) as any;
        if (response?.channel?.id) {
          createdChannel = client.channel('messaging', response.channel.id);
          await createdChannel.watch({ messages: { limit: 25, include_hidden_messages: true } });
          markChannelAsFullyQueried(createdChannel.cid);
          if (e2eeEnabled && client.mlsManager?.initialized && createdChannel.id) {
            client.mlsManager.archiveCurrentEpoch(createdChannel.type, createdChannel.id)
              .catch((err: unknown) => console.warn('[E2EE] Initial epoch archive failed:', err));
          }
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
          public: e2eeEnabled ? false : isPublic,
        };

        if (description.trim()) {
          payload.description = description.trim();
        }

        if (e2eeEnabled) {
          const mlsManager = client.mlsManager;
          if (!mlsManager?.initialized) {
            throw new Error(e2eeUnavailableLabel);
          }
          const uuid =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : Math.random().toString(36).slice(2);
          const channelId = `${client.projectId}:${uuid}`;
          const cid = `team:${channelId}`;
          const bundle = await mlsManager.createE2eeChannel('team', channelId, cid, memberIds);
          Object.assign(payload, {
            mls_enabled: true,
            ...bundle,
          });
          createdChannel = client.channel('team', channelId, payload);
        } else {
          createdChannel = client.channel('team', payload);
        }
        const response = (await createdChannel.create()) as any;
        if (response?.channel?.id) {
          createdChannel = client.channel('team', response.channel.id);
          await createdChannel.watch({ messages: { limit: 25, include_hidden_messages: true } });
          markChannelAsFullyQueried(createdChannel.cid);
          if (e2eeEnabled && client.mlsManager?.initialized && createdChannel.id) {
            client.mlsManager.archiveCurrentEpoch(createdChannel.type, createdChannel.id)
              .catch((err: unknown) => console.warn('[E2EE] Initial epoch archive failed:', err));
          }
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
  }, [
    client,
    currentUserId,
    isCreating,
    selectedUsers,
    tab,
    name,
    isPublic,
    description,
    e2eeEnabled,
    e2eeUnavailableLabel,
    onSuccess,
    onClose,
  ]);


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
        nextButtonLabel={nextButtonLabel}
        backButtonLabel={backButtonLabel}
        e2eeEnabled={e2eeEnabled}
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
          {nextButtonLabel}
        </button>
      </div>
    );
  } else if (tab === 'team' && step === 2) {
    footer = (
      <div className="ermis-create-channel__footer">
        <button className="ermis-create-channel__btn ermis-create-channel__btn--cancel" onClick={() => { setError(null); setStep(1); }} disabled={isCreating}>{backButtonLabel}</button>
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
            setE2eeEnabled(false);
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
              setE2eeEnabled(false);
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
              setE2eeEnabled(false);
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
              e2eeEnabled={e2eeEnabled}
              onE2eeChange={handleE2eeChange}
              e2eeLabel={e2eeLabel}
              e2eeDescription={e2eeDescription}
              e2eeDisabled={!e2eeAvailable || isCreating}
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

              <DefaultE2eeToggle
                enabled={e2eeEnabled}
                onChange={handleE2eeChange}
                disabled={!e2eeAvailable || isCreating}
                label={e2eeLabel}
                description={e2eeAvailable ? e2eeDescription : e2eeUnavailableLabel}
              />
            </>
          )
        )}

        {tab === 'messaging' && (
          <E2eeToggleComponent
            enabled={e2eeEnabled}
            onChange={handleE2eeChange}
            disabled={!e2eeAvailable || isCreating}
            label={e2eeLabel}
            description={e2eeAvailable ? e2eeDescription : e2eeUnavailableLabel}
          />
        )}

        {/* User Selection - Step 2 (Group) or Step 1 (Messaging) */}
        {((tab === 'team' && step === 2) || tab === 'messaging') && (
          <div className={`ermis-create-channel__users ermis-create-channel__users--${tab}`}>
            <UserPicker
              key={tab}
              mode={tab === 'messaging' ? 'radio' : 'checkbox'}
              friendsOnly={tab === 'team'}
              onSelectionChange={setSelectedUsers}
              initialSelectedUsers={selectedUsers}
              emptyText={emptyStateLabel}
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
