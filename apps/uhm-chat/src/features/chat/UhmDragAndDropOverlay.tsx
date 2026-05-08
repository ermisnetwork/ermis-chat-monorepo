import React from 'react';

export type UhmDragAndDropOverlayProps = {
  dragAndDropLabel: string;
};

export const UhmDragAndDropOverlay: React.FC<UhmDragAndDropOverlayProps> = ({ dragAndDropLabel }) => {
  return (
    <div className="fixed inset-0 z-[9999] bg-white/40 dark:bg-black/40 backdrop-blur-[4px] flex items-center justify-center pointer-events-none">
      <div className="border-2 border-dashed border-primary rounded-2xl p-10 flex flex-col items-center gap-4 text-primary bg-white dark:bg-[#1a1828] shadow-[0_8px_32px_rgba(0,0,0,0.12)]">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <span className="text-xl font-semibold tracking-tight">
          {dragAndDropLabel}
        </span>
      </div>
    </div>
  );
};
