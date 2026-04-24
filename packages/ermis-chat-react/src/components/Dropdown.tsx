import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// Global event name used to close any other open dropdowns
const CLOSE_ALL_EVENT = 'ermis:close-all-dropdowns';

/** Dispatch a global event to close all open dropdowns */
export const closeAllDropdowns = () => {
  document.dispatchEvent(new CustomEvent(CLOSE_ALL_EVENT));
};

import type { DropdownProps } from '../types';

export const Dropdown: React.FC<DropdownProps> = ({
  isOpen,
  anchorRect,
  onClose,
  children,
  align = 'left',
  className = '',
  style: propStyle = {},
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceId = useRef(Math.random().toString(36).slice(2));

  // Listen for global close event — only register when open to avoid N listeners
  useEffect(() => {
    if (!isOpen) return;

    // Broadcast: close all OTHER open dropdowns
    document.dispatchEvent(new CustomEvent(CLOSE_ALL_EVENT, { detail: instanceId.current }));

    const handleGlobalClose = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail !== instanceId.current) {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      // Allow the click to process if it's on a trigger button so it can toggle itself
      // We rely on the trigger stopping propagation or using the global close event.
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const handleScroll = () => onClose();

    // Delay click listener to prevent instant close from the opening click
    const tid = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 10);

    document.addEventListener(CLOSE_ALL_EVENT, handleGlobalClose);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('scroll', handleScroll, true);

    return () => {
      clearTimeout(tid);
      document.removeEventListener(CLOSE_ALL_EVENT, handleGlobalClose);
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !anchorRect) return null;

  const spaceBelow = window.innerHeight - anchorRect.bottom;
  const spaceAbove = anchorRect.top;
  const estimatedDropdownHeight = 250;

  let verticalStyle: React.CSSProperties = {};
  if (spaceBelow < estimatedDropdownHeight && spaceAbove > spaceBelow) {
    // Open upwards (bottom-aligned to the top of the trigger)
    verticalStyle = { bottom: window.innerHeight - anchorRect.top + 4 };
  } else {
    // Open downwards
    verticalStyle = { top: anchorRect.bottom + 4 };
  }

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 99999,
    ...verticalStyle,
    ...(align === 'right'
      ? { right: window.innerWidth - anchorRect.right }
      : { left: anchorRect.left }),
    ...propStyle
  };

  const portalTarget = document.querySelector('.ermis-chat') || document.body;

  return createPortal(
    <div ref={containerRef} className={`ermis-dropdown ${className}`.trim()} style={style}>
      {children}
    </div>,
    portalTarget
  );
};
