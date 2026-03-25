import { useState, useCallback, useRef } from 'react';

export type UseEmojiPickerOptions = {
  editableRef: React.RefObject<HTMLDivElement | null>;
  setHasContent: (value: boolean) => void;
};

export function useEmojiPicker({ editableRef, setHasContent }: UseEmojiPickerOptions) {
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const savedRangeRef = useRef<Range | null>(null);

  const handleEmojiSelect = useCallback((emoji: string) => {
    const el = editableRef.current;
    if (!el) return;

    // Restore saved cursor position, or move to end
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      if (savedRangeRef.current) {
        sel.addRange(savedRangeRef.current);
        savedRangeRef.current = null;
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.addRange(range);
      }
    }

    document.execCommand('insertText', false, emoji + ' ');
    setHasContent(true);
    setEmojiPickerOpen(false);
  }, [editableRef, setHasContent]);

  const handleEmojiClose = useCallback(() => {
    setEmojiPickerOpen(false);
    savedRangeRef.current = null;
  }, []);

  const toggleEmojiPicker = useCallback(() => {
    // Save current cursor position before picker steals focus
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
    setEmojiPickerOpen((prev) => !prev);
  }, []);

  return {
    emojiPickerOpen,
    handleEmojiSelect,
    handleEmojiClose,
    toggleEmojiPicker,
  };
}
