import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import type { ModalProps } from '@ermis-network/ermis-chat-react';

export const UhmModal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = '400px',
  hideCloseButton,
  closeOnOutsideClick = true,
}) => {
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && closeOnOutsideClick) {
          onClose();
        }
      }}
    >
      <DialogContent
        style={{ maxWidth }}
        hideCloseButton={hideCloseButton}
        className="flex flex-col max-h-[90vh] p-0 overflow-hidden gap-0"
        onInteractOutside={(e) => {
          if (!closeOnOutsideClick) {
            e.preventDefault();
          }
        }}
      >
        {title && (
          <DialogHeader className="p-6 pb-2 border-b border-zinc-100 dark:border-zinc-800">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
        )}
        
        <div className="flex-1 overflow-y-auto p-6 min-h-0">
          {children}
        </div>
        
        {footer && (
          <DialogFooter className="p-6 pt-2 border-t border-zinc-100 dark:border-zinc-800">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
