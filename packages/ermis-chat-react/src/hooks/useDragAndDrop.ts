import { useState, useEffect, useCallback, useRef } from 'react';
import { isHeicFile, isVideoFile } from '@ermis-network/ermis-chat-sdk';

export function useDragAndDrop(
  onFilesDrop: (files: FileList) => void,
  disabled: boolean = false
) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (disabled) return;

    dragCounter.current += 1;

    // Only allow files
    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      const hasFiles = Array.from(e.dataTransfer.items).some(
        (item) => item.kind === 'file'
      );
      if (hasFiles) {
        setIsDragging(true);
      }
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (disabled) return;

    dragCounter.current -= 1;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, [disabled]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    dragCounter.current = 0;
    setIsDragging(false);

    if (disabled) return;

    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      onFilesDrop(e.dataTransfer.files);
    }
  }, [disabled, onFilesDrop]);

  useEffect(() => {
    // Attach to the entire window so anywhere the user drags a file in the chat layout, it works
    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  return {
    isDragging,
  };
}
