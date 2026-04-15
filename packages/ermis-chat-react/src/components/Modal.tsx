import React, { useEffect } from 'react';
import type { ModalProps } from '../types';

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = '480px',
  hideCloseButton = false,
  closeOnOutsideClick = true,
}) => {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="ermis-modal-overlay" onClick={closeOnOutsideClick ? onClose : undefined}>
      <div 
        className="ermis-modal-content" 
        style={{ maxWidth }} 
        onClick={e => e.stopPropagation()}
      >
        {(title || !hideCloseButton) && (
          <div className="ermis-modal-header">
            {title ? (
              typeof title === 'string' ? <h3>{title}</h3> : title
            ) : <div />}
            {!hideCloseButton && (
              <button className="ermis-modal-close" onClick={onClose} aria-label="Close">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            )}
          </div>
        )}

        <div className="ermis-modal-body">
          {children}
        </div>

        {footer && (
          <div className="ermis-modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
