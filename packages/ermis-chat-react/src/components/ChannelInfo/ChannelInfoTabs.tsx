import React from 'react';
import { VList as _VList } from 'virtua';
const VList = _VList as any;
import { PENDING_STYLE, READY_STYLE } from './utils';
import { MediaLightbox } from '../MediaLightbox';
import type { ChannelInfoTabsProps, ChannelInfoTabHeaderProps } from '../../types';
import { useChannelInfoTabs } from './useChannelInfoTabs';

/* =============================================
   Component: DefaultChannelInfoTabHeader
   Renders the tab buttons row.
   ============================================= */

export const DefaultChannelInfoTabHeader: React.FC<ChannelInfoTabHeaderProps> = React.memo(({
  activeTab,
  onTabChange,
  availableTabs,
}) => {
  return (
    <div className="ermis-channel-info__media-tabs">
      {availableTabs.map(tab => (
        <button
          key={tab}
          className={`ermis-channel-info__media-tab ${activeTab === tab ? 'ermis-channel-info__media-tab--active' : ''}`}
          onClick={() => onTabChange(tab)}
        >
          <span className="ermis-channel-info__media-tab-label">
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </span>
        </button>
      ))}
    </div>
  );
});
DefaultChannelInfoTabHeader.displayName = 'DefaultChannelInfoTabHeader';

/* =============================================
   Component: DefaultChannelInfoTabs
   Self-contained tabs component with internal VList.
   Kept for backward compatibility.
   ============================================= */

export const DefaultChannelInfoTabs: React.FC<ChannelInfoTabsProps> = React.memo((props) => {
  const {
    TabHeaderComponent,
  } = props;

  const tabs = useChannelInfoTabs(props);
  const TabHeader = TabHeaderComponent || DefaultChannelInfoTabHeader;

  return (
    <div className="ermis-channel-info__section ermis-channel-info__media-section">
      <TabHeader
        activeTab={tabs.activeTab}
        onTabChange={tabs.handleTabChange}
        availableTabs={tabs.availableTabs}
        tabCounts={{} as any}
      />

      <div
        className="ermis-channel-info__media-content"
        style={tabs.isPending ? PENDING_STYLE : READY_STYLE}
      >
        {tabs.isPending || (tabs.loading && tabs.contentTab !== 'members') ? <tabs.Loading /> : tabs.isTabEmpty ? <tabs.EmptyState label={tabs.emptyLabel} /> : (
          <VList data={tabs.vlistData}>
            {tabs.renderVlistItem}
          </VList>
        )}
      </div>

      {/* Media Lightbox */}
      {tabs.lightboxItems.length > 0 && (
        <MediaLightbox
          items={tabs.lightboxItems}
          initialIndex={tabs.lightboxIndex}
          isOpen={tabs.lightboxOpen}
          onClose={tabs.closeLightbox}
        />
      )}
    </div>
  );
});
DefaultChannelInfoTabs.displayName = 'DefaultChannelInfoTabs';
