import React, { useState, useEffect } from 'react';
import { Panel } from '../Panel';
import type { ChannelSettingsPanelProps } from '../../types';

export const ChannelSettingsPanel: React.FC<ChannelSettingsPanelProps> = React.memo(({
  isOpen,
  onClose,
  channel,
  title = 'Channel Settings',
  slowModeOptions = [
    { label: 'Off', value: 0 },
    { label: '1s', value: 1 },
    { label: '5s', value: 5 },
    { label: '10s', value: 10 },
    { label: '30s', value: 30 },
    { label: '1m', value: 60 },
    { label: '5m', value: 300 },
  ],
}) => {
  // Config state
  const [slowMode, setSlowMode] = useState<number>(0);
  const [capabilities, setCapabilities] = useState({
    send_messages: true,
    send_media: true,
    send_links: true,
    send_files: true,
  });
  
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state when panel opens
  useEffect(() => {
    if (isOpen && channel) {
      setSlowMode((channel.data?.slow_mode as number) || 0);
      setKeywords((channel.data?.keywords as string[]) || []);
      
      const caps = channel.data?.capabilities as any || {};
      setCapabilities({
        send_messages: caps.send_messages ?? true,
        send_media: caps.send_media ?? true,
        send_links: caps.send_links ?? true,
        send_files: caps.send_files ?? true,
      });
      setError(null);
    }
  }, [isOpen, channel]);

  const toggleCapability = (key: keyof typeof capabilities) => {
    setCapabilities(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleAddNewKeyword = () => {
    if (newKeyword.trim()) {
      const keyword = newKeyword.trim().toLowerCase();
      if (!keywords.includes(keyword)) {
        setKeywords(prev => [...prev, keyword]);
      }
      setNewKeyword('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddNewKeyword();
    }
  };

  const handeRemoveKeyword = (kw: string) => {
    setKeywords(prev => prev.filter(k => k !== kw));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await channel.update({
        slow_mode: slowMode,
        keywords,
        capabilities,
      } as any);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to update settings');
    } finally {
      setIsSaving(false);
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
          padding: '24px 20px', 
          overflowY: 'auto', 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '24px',
          background: 'var(--ermis-bg-secondary)',
          minHeight: '100%'
        }}
      >
        
        {/* Section 1: Permissions */}
        <section 
          className="ermis-settings-panel__section" 
          style={{ 
            background: 'var(--ermis-bg-primary)', 
            padding: '20px', 
            borderRadius: '16px', 
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            border: '1px solid var(--ermis-border-color)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px', gap: '8px' }}>
            <div style={{ background: 'var(--ermis-color-primary-light)', padding: '6px', borderRadius: '8px', color: 'var(--ermis-color-primary)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            </div>
            <h4 style={{ fontSize: '15px', color: 'var(--ermis-text-primary)', fontWeight: 600, margin: 0 }}>
              Member Permissions
            </h4>
          </div>
          
          <div className="ermis-settings-panel__field" style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '13px', color: 'var(--ermis-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Slow Mode
            </label>
            <div style={{ position: 'relative' }}>
              <select 
                value={slowMode} 
                onChange={e => setSlowMode(Number(e.target.value))}
                style={{ 
                  width: '100%', 
                  padding: '12px 14px', 
                  borderRadius: '10px', 
                  border: '1px solid var(--ermis-border-color)', 
                  background: 'var(--ermis-bg-secondary)', 
                  color: 'var(--ermis-text-primary)',
                  fontSize: '15px',
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
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '13px', color: 'var(--ermis-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Capabilities
            </label>
            <div style={{ background: 'var(--ermis-bg-secondary)', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--ermis-border-color)' }}>
              {Object.entries(capabilities).map(([key, value], index, arr) => (
                <div 
                  key={key} 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderBottom: index < arr.length - 1 ? '1px solid var(--ermis-border-color)' : 'none'
                  }}
                >
                  <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--ermis-text-primary)' }}>
                    {key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={value}
                    className={`ermis-channel-info__edit-toggle ${value ? 'ermis-channel-info__edit-toggle--on' : ''}`}
                    onClick={() => toggleCapability(key as keyof typeof capabilities)}
                    disabled={isSaving}
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
            padding: '20px', 
            borderRadius: '16px', 
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            border: '1px solid var(--ermis-border-color)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px', gap: '8px' }}>
            <div style={{ background: 'var(--ermis-color-danger-light)', padding: '6px', borderRadius: '8px', color: 'var(--ermis-color-danger)' }}>
               <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
            </div>
            <h4 style={{ fontSize: '15px', color: 'var(--ermis-text-primary)', fontWeight: 600, margin: 0 }}>
              Content Moderation
            </h4>
          </div>
          
          <div className="ermis-settings-panel__field" style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '13px', color: 'var(--ermis-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
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
                  padding: '12px 14px', 
                  borderRadius: '10px', 
                  border: '1px solid var(--ermis-border-color)', 
                  background: 'var(--ermis-bg-secondary)', 
                  color: 'var(--ermis-text-primary)',
                  fontSize: '15px',
                  outline: 'none'
                }}
                disabled={isSaving}
              />
              <button
                type="button"
                onClick={handleAddNewKeyword}
                disabled={isSaving || !newKeyword.trim()}
                style={{
                  padding: '0 16px',
                  borderRadius: '10px',
                  background: 'var(--ermis-color-primary-light)',
                  color: 'var(--ermis-color-primary)',
                  border: 'none',
                  fontWeight: 600,
                  fontSize: '14px',
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
                  gap: '6px', 
                  padding: '4px 10px', 
                  borderRadius: '20px', 
                  background: 'var(--ermis-color-danger-light)', 
                  color: 'var(--ermis-color-danger)',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  fontSize: '13px', 
                  fontWeight: 600 
                }}
              >
                {kw}
                <button 
                  onClick={() => handeRemoveKeyword(kw)}
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

      </div>

      {/* Footer Area */}
      <div 
        className="ermis-settings-panel__footer" 
        style={{ 
          marginTop: 'auto', 
          padding: '16px 20px', 
          background: 'var(--ermis-bg-primary)',
          borderTop: '1px solid var(--ermis-border-color)', 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '12px' 
        }}
      >
        {error && (
          <div style={{ color: 'var(--ermis-color-danger)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
             {error}
          </div>
        )}
        <button 
          onClick={handleSave} 
          disabled={isSaving}
          style={{ 
            width: '100%', 
            padding: '12px', 
            borderRadius: '10px', 
            background: 'var(--ermis-color-primary)', 
            color: 'white', 
            border: 'none', 
            fontSize: '15px',
            fontWeight: 600, 
            cursor: isSaving ? 'not-allowed' : 'pointer', 
            opacity: isSaving ? 0.6 : 1,
            transition: 'all 0.2s ease',
            boxShadow: '0 4px 12px rgba(var(--ermis-color-primary-rgb, 0,0,0), 0.2)'
          }}
        >
          {isSaving ? (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <svg className="ermis-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
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
