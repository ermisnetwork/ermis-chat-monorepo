import React, { useState, useEffect } from 'react';
import { Panel as DefaultPanel } from '../Panel';
import { useChatComponents } from '../../context/ChatComponentsContext';
import { useChatClient } from '../../hooks/useChatClient';
import type { ChannelSettingsPanelProps } from '../../types';
import { isGroupChannel } from '../../channelTypeUtils';
import { CHANNEL_ROLES } from '../../channelRoleUtils';

import { useChannelSettings } from './useChannelSettings';

export const ChannelSettingsPanel: React.FC<ChannelSettingsPanelProps> = React.memo(({
  isOpen,
  onClose,
  channel,
  title = 'Channel Settings',
  slowModeOptions = [
    { label: 'Off', value: 0 },
    { label: '10s', value: 10000 },
    { label: '30s', value: 30000 },
    { label: '1m', value: 60000 },
    { label: '5m', value: 300000 },
    { label: '15m', value: 900000 },
    { label: '1h', value: 3600000 },
  ],
  workspaceTopicsTitle = 'Workspace Topics',
  topicsFeatureName = 'Topics',
  topicsFeatureDescription = 'Allow users to reply to messages with dedicated conversation threads. Disabling this hides the reply-in-topic button for everyone.',
}) => {
  const { client } = useChatClient();
  const { PanelComponent } = useChatComponents();
  const Panel = PanelComponent || DefaultPanel;
  const currentUserId = client?.userID;
  const currentUserRole = currentUserId ? channel?.state?.members?.[currentUserId]?.channel_role : undefined;

  const {
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
  } = useChannelSettings({
    channel: channel as any,
    isOpen,
    onClose,
    currentUserRole,
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddNewKeyword();
    }
  };

  // We do NOT return null based on !isOpen so the sliding CSS transition is preserved.
  return (
    <Panel isOpen={isOpen} onClose={onClose} title={title} className="ermis-settings-panel">

      {/* 
        This wrapper creates a neat scrollable area with subtle gray background
        which makes white cards pop out smoothly.
      */}
      <div
        className="ermis-settings-panel__body"
        style={{
          flex: 1,
          minHeight: 0,
          padding: '16px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          background: 'var(--ermis-bg-secondary)'
        }}
      >

        {/* Section 1: Permissions */}
        <section
          className="ermis-settings-panel__section"
          style={{
            background: 'var(--ermis-bg-primary)',
            padding: '16px',
            borderRadius: '12px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            border: '1px solid var(--ermis-border-color)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px', gap: '8px' }}>
            <div style={{ background: 'var(--ermis-color-primary-light)', padding: '4px', borderRadius: '8px', color: 'var(--ermis-color-primary)' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <h4 style={{ fontSize: '14px', color: 'var(--ermis-text-primary)', fontWeight: 600, margin: 0 }}>
              Member Permissions
            </h4>
          </div>

          <div className="ermis-settings-panel__field" style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '12px', color: 'var(--ermis-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Slow Mode
            </label>
            <div style={{ position: 'relative' }}>
              <select
                value={slowMode}
                onChange={e => setSlowMode(Number(e.target.value))}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--ermis-border-color)',
                  background: 'var(--ermis-bg-secondary)',
                  color: 'var(--ermis-text-primary)',
                  fontSize: '14px',
                  fontWeight: 500,
                  appearance: 'none',
                  outline: 'none',
                  cursor: isSaving ? 'not-allowed' : 'pointer',
                  transition: 'border-color 0.2s'
                }}
                disabled={isSaving}
              >
                {slowModeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <div style={{ position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--ermis-text-secondary)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>
          </div>

          <div className="ermis-settings-panel__toggles" style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '12px', color: 'var(--ermis-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Capabilities
            </label>
            <div style={{ background: 'var(--ermis-bg-secondary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--ermis-border-color)' }}>
              {Object.entries(capabilities).map(([key, value], index, arr) => (
                <div
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    borderBottom: index < arr.length - 1 ? '1px solid var(--ermis-border-color)' : 'none'
                  }}
                >
                  <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--ermis-text-primary)' }}>
                    {key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={value}
                    className={`ermis-channel-info__edit-toggle ${value ? 'ermis-channel-info__edit-toggle--on' : ''}`}
                    onClick={() => toggleCapability(key)}
                    disabled={isSaving}
                    style={{ transform: 'scale(0.85)', transformOrigin: 'right center' }}
                  >
                    <span className="ermis-channel-info__edit-toggle-thumb" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Section 2: Content Moderation */}
        <section
          className="ermis-settings-panel__section"
          style={{
            background: 'var(--ermis-bg-primary)',
            padding: '16px',
            borderRadius: '12px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            border: '1px solid var(--ermis-border-color)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px', gap: '8px' }}>
            <div style={{ background: 'var(--ermis-color-danger-light)', padding: '4px', borderRadius: '8px', color: 'var(--ermis-color-danger)' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
            </div>
            <h4 style={{ fontSize: '14px', color: 'var(--ermis-text-primary)', fontWeight: 600, margin: 0 }}>
              Content Moderation
            </h4>
          </div>

          <div className="ermis-settings-panel__field" style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '12px', color: 'var(--ermis-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Keyword Filtering
            </label>
            <div style={{ display: 'flex', gap: '8px', position: 'relative' }}>
              <input
                type="text"
                value={newKeyword}
                onChange={e => setNewKeyword(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type keyword and press Enter or Add..."
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--ermis-border-color)',
                  background: 'var(--ermis-bg-secondary)',
                  color: 'var(--ermis-text-primary)',
                  fontSize: '14px',
                  outline: 'none'
                }}
                disabled={isSaving}
              />
              <button
                type="button"
                onClick={handleAddNewKeyword}
                disabled={isSaving || !newKeyword.trim()}
                style={{
                  padding: '0 12px',
                  borderRadius: '8px',
                  background: 'var(--ermis-color-primary-light)',
                  color: 'var(--ermis-color-primary)',
                  border: 'none',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: isSaving || !newKeyword.trim() ? 'not-allowed' : 'pointer',
                  opacity: isSaving || !newKeyword.trim() ? 0.6 : 1,
                  transition: 'opacity 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                Add
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', minHeight: '32px' }}>
            {keywords.map(kw => (
              <span
                key={kw}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '3px 8px',
                  borderRadius: '16px',
                  background: 'var(--ermis-color-danger-light)',
                  color: 'var(--ermis-color-danger)',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  fontSize: '12px',
                  fontWeight: 600
                }}
              >
                {kw}
                <button
                  onClick={() => handleRemoveKeyword(kw)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px',
                    color: 'inherit',
                    opacity: 0.8,
                  }}
                  disabled={isSaving}
                  aria-label="Remove keyword"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </span>
            ))}
            {keywords.length === 0 && (
              <span style={{ fontSize: '14px', color: 'var(--ermis-text-secondary)', padding: '6px 0', fontStyle: 'italic' }}>
                No blacklisted keywords added.
              </span>
            )}
          </div>
        </section>

        {/* Section 3: Features */}
        {isGroupChannel(channel) && (
          <section
            className="ermis-settings-panel__section"
            style={{
              background: 'var(--ermis-bg-primary)',
              padding: '16px',
              borderRadius: '12px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
              border: '1px solid var(--ermis-border-color)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px', gap: '8px' }}>
              <div style={{ background: 'rgba(168, 85, 247, 0.1)', padding: '4px', borderRadius: '8px', color: '#a855f7' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                  <polyline points="2 17 12 22 22 17"></polyline>
                  <polyline points="2 12 12 17 22 12"></polyline>
                </svg>
              </div>
              <h4 style={{ fontSize: '14px', color: 'var(--ermis-text-primary)', fontWeight: 600, margin: 0 }}>
                {workspaceTopicsTitle}
              </h4>
            </div>

            <div className="ermis-settings-panel__toggles" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ background: 'var(--ermis-bg-secondary)', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--ermis-border-color)' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--ermis-text-primary)' }}>
                      {topicsFeatureName}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--ermis-text-secondary)', marginTop: '2px' }}>
                      {topicsFeatureDescription}
                    </span>
                    {!isOwner && (
                      <span style={{ fontSize: '11px', color: 'var(--ermis-color-danger)', marginTop: '4px', fontWeight: 500 }}>
                        Only channel owner can change this.
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={topicsEnabled}
                    className={`ermis-channel-info__edit-toggle ${topicsEnabled ? 'ermis-channel-info__edit-toggle--on' : ''}`}
                    onClick={() => isOwner && setTopicsEnabled(!topicsEnabled)}
                    disabled={isSaving || !isOwner}
                    style={{ transform: 'scale(0.85)', transformOrigin: 'right center', cursor: (!isOwner || isSaving) ? 'not-allowed' : 'pointer' }}
                  >
                    <span className="ermis-channel-info__edit-toggle-thumb" />
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}


      </div>

      {/* Footer Area */}
      <div
        className="ermis-settings-panel__footer"
        style={{
          flexShrink: 0,
          padding: '12px 16px',
          background: 'var(--ermis-bg-primary)',
          borderTop: '1px solid var(--ermis-border-color)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}
      >
        {error && (
          <div style={{ color: 'var(--ermis-color-danger)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            {error}
          </div>
        )}
        <button
          onClick={handleSave}
          disabled={isSaving || !isDirty}
          style={{
            width: '100%',
            padding: '10px',
            borderRadius: '8px',
            background: 'var(--ermis-color-primary, #006eff)',
            color: '#ffffff',
            border: 'none',
            fontSize: '14px',
            fontWeight: 600,
            cursor: (isSaving || !isDirty) ? 'not-allowed' : 'pointer',
            opacity: (isSaving || !isDirty) ? 0.6 : 1,
            transition: 'all 0.2s ease',
            boxShadow: (isSaving || !isDirty) ? 'none' : '0 4px 12px rgba(0, 110, 255, 0.2)'
          }}
        >
          {isSaving ? (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <svg className="ermis-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
              </svg>
              Saving...
            </span>
          ) : 'Save Updates'}
        </button>
      </div>

    </Panel>
  );
});

ChannelSettingsPanel.displayName = 'ChannelSettingsPanel';
