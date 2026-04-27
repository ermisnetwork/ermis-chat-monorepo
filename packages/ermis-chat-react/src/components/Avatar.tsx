import React, { useMemo, useState } from 'react';
import { MediaLightbox } from './MediaLightbox';
import { getAvatarGradient } from '../utils/avatarColors';
import type { AvatarProps } from '../types';

export type { AvatarProps } from '../types';

/**
 * Extracts 1–2 initials from a name.
 */
function getInitials(name?: string): string {
  if (!name) return '?';
  if (name.startsWith('0x')) return '0x';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return parts[0][0].toUpperCase();
}

/**
 * Avatar component with image or initial fallback.
 */
export const Avatar: React.FC<AvatarProps> = React.memo(({
  image,
  name,
  size = 36,
  className,
  disableLightbox,
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const imgRef = React.useRef<HTMLImageElement>(null);

  // Reset state if image URL changes
  React.useEffect(() => {
    if (image) {
      setHasError(false);
      if (imgRef.current?.complete) {
        setIsLoaded(true);
      } else {
        setIsLoaded(false);
      }
    }
  }, [image]);

  const initials = useMemo(() => getInitials(name), [name]);

  const wrapperStyle = useMemo<React.CSSProperties>(() => ({
    width: size,
    height: size,
    minWidth: size,
    position: 'relative',
    borderRadius: '100%', /* Or var(--ermis-radius-full) */
    overflow: 'hidden',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: image && !hasError && !disableLightbox ? 'pointer' : undefined,
  }), [size, image, hasError, disableLightbox]);

  const contentStyle = useMemo<React.CSSProperties>(() => ({
    width: '100%',
    height: '100%',
    fontSize: size * 0.4,
    lineHeight: 1,
  }), [size]);

  const handleAvatarClick = React.useCallback((e: React.MouseEvent) => {
    if (image && !hasError && !disableLightbox) {
      e.stopPropagation();
      e.preventDefault();
      setIsLightboxOpen(true);
    }
  }, [image, hasError, disableLightbox]);

  return (
    <>
      <div 
        className={`ermis-avatar-wrapper${className ? ` ${className}` : ''}`} 
        style={wrapperStyle}
        onClick={handleAvatarClick}
      >
        {/* 1. Underlying Fallback (Placeholder) */}
        <div
          className="ermis-avatar ermis-avatar--fallback"
          style={{ ...contentStyle, background: getAvatarGradient(name) }}
          title={name}
        >
          {initials}
        </div>

        {/* 2. Actual Image (Lazy, Fades in natively using CSS opacity) */}
        {image && !hasError && (
          <img
            ref={imgRef}
            className="ermis-avatar__img"
            src={image}
            alt={name || 'Avatar'}
            loading="lazy"
            onLoad={() => setIsLoaded(true)}
            onError={() => setHasError(true)}
            style={{
              ...contentStyle,
              position: 'absolute',
              top: 0,
              left: 0,
              opacity: isLoaded ? 1 : 0,
              transition: 'opacity 0.3s ease-in-out',
              objectFit: 'cover',
            }}
          />
        )}
      </div>

      {isLightboxOpen && image && !hasError && (
        <MediaLightbox
          items={[{ type: 'image', src: image, alt: name || 'Avatar' }]}
          isOpen={isLightboxOpen}
          onClose={() => setIsLightboxOpen(false)}
        />
      )}
    </>
  );
});

Avatar.displayName = 'Avatar';
