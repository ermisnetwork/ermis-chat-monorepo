export interface SongQueueItem {
  id: string;
  videoId: string;
  title: string;
  thumbnailUrl?: string;
  requestedBy: string;
  requestedByUserId?: string;
  addedAt: number;
}

export type MusicSyncAction =
  | 'PLAY'
  | 'PAUSE'
  | 'NEXT'
  | 'SYNC_STATE'
  | 'REQUEST_SYNC'
  | 'QUEUE_UPDATE';

export interface MusicControlEvent {
  type: 'music.control';
  action: MusicSyncAction;
  videoId?: string;
  currentTime?: number;
  title?: string;
  requestedBy?: string;
  isPlaying?: boolean;
  queue?: SongQueueItem[];
  hostId?: string;
  timestamp: number;
}

export const YOUTUBE_REGEX =
  /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

/**
 * Extracts YouTube 11-char Video ID from text or message content.
 */
export function extractYouTubeVideoId(text: string): string | null {
  if (!text) return null;
  const match = text.match(YOUTUBE_REGEX);
  return match ? match[1] : null;
}

/**
 * Fetches YouTube video metadata (title and thumbnail) via public oEmbed endpoint.
 * No API key required. Falls back gracefully if blocked or unavailable.
 */
export async function fetchYouTubeVideoInfo(
  videoId: string
): Promise<{ title: string; thumbnailUrl: string }> {
  const defaultThumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  const defaultTitle = `YouTube Video (${videoId})`;

  try {
    const oEmbedUrl = `https://noembed.com/embed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}`;
    const response = await fetch(oEmbedUrl);
    if (!response.ok) {
      // Try official YouTube oEmbed if noembed fails
      const ytOembed = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const ytResponse = await fetch(ytOembed);
      if (ytResponse.ok) {
        const data = await ytResponse.json();
        return {
          title: data.title || defaultTitle,
          thumbnailUrl: data.thumbnail_url || defaultThumbnail,
        };
      }
      return { title: defaultTitle, thumbnailUrl: defaultThumbnail };
    }
    const data = await response.json();
    return {
      title: data.title || defaultTitle,
      thumbnailUrl: data.thumbnail_url || defaultThumbnail,
    };
  } catch (error) {
    console.warn('[YouTube Helper] Error fetching oEmbed video info:', error);
    return { title: defaultTitle, thumbnailUrl: defaultThumbnail };
  }
}
