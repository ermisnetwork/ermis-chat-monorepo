import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Cat } from 'lucide-react';

interface StickerPickerPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stickerIframeUrl: string;
  disabled?: boolean;
  title?: string;
}

export const StickerPickerPopover: React.FC<StickerPickerPopoverProps> = ({
  open,
  onOpenChange,
  stickerIframeUrl,
  disabled,
  title,
}) => {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center justify-center w-9 h-9 rounded-full text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={title}
        >
          <Cat className="w-[18px] h-[18px]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={12}
          className="z-[100] w-[350px] h-[400px] bg-white dark:bg-[#1a1828] rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden animate-in fade-in zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95"
        >
          {open && (
            <iframe
              src={stickerIframeUrl}
              className="w-full h-full border-none"
              title="Sticker Picker"
              sandbox="allow-scripts allow-same-origin"
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
