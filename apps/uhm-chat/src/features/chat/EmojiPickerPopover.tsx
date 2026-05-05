import React, { useState } from 'react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import * as Popover from '@radix-ui/react-popover';
import { Smile } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface EmojiPickerPopoverProps {
  onEmojiSelect: (emoji: { native: string }) => void;
  disabled?: boolean;
}

export const EmojiPickerPopover: React.FC<EmojiPickerPopoverProps> = ({ onEmojiSelect, disabled }) => {
  const [open, setOpen] = useState(false);
  const { t, i18n } = useTranslation();

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center justify-center w-9 h-9 rounded-full text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={t('chat.addEmoji', 'Add Emoji')}
        >
          <Smile className="w-5 h-5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={12}
          className="z-[100] animate-in fade-in zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95"
        >
          <div className="shadow-xl rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
            <Picker
              data={data}
              onEmojiSelect={(emoji: { native: string }) => {
                onEmojiSelect(emoji);
                setOpen(false);
              }}
              locale={i18n.language === 'vi' ? 'vi' : 'en'}
              theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
