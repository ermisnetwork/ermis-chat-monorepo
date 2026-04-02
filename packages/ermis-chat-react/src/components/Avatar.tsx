import React, { useMemo } from 'react';
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
}) => {
  const [isLoaded, setIsLoaded] = React.useState(false);
  const [hasError, setHasError] = React.useState(false);

  // Reset state if image URL changes
  React.useEffect(() => {
    if (image) {
      setIsLoaded(false);
      setHasError(false);
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
  }), [size]);

  const contentStyle = useMemo<React.CSSProperties>(() => ({
    width: '100%',
    height: '100%',
    fontSize: size * 0.4,
    lineHeight: 1,
  }), [size]);

  return (
    <div className={`ermis-avatar-wrapper${className ? ` ${className}` : ''}`} style={wrapperStyle}>
      {/* 1. Underlying Fallback (Placeholder) */}
      <div
        className="ermis-avatar ermis-avatar--fallback"
        style={contentStyle}
        title={name}
      >
        {initials}
      </div>

      {/* 2. Actual Image (Lazy, Fades in natively using CSS opacity) */}
      {image && !hasError && (
        <img
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
  );
});

Avatar.displayName = 'Avatar';
