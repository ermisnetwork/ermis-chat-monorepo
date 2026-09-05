import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { Channel as ChannelType } from '@ermis-network/ermis-chat-sdk';
import {
  Music,
  Play,
  Pause,
  SkipForward,
  Volume2,
  VolumeX,
  Trash2,
  ListMusic,
  ChevronDown,
  ChevronUp,
  X,
  Sparkles,
  Speaker,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  SongQueueItem,
  MusicControlEvent,
} from './youtubeHelpers';
import {
  extractYouTubeVideoId,
  fetchYouTubeVideoInfo,
} from './youtubeHelpers';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface UhmMusicRoomPlayerProps {
  channel: ChannelType | null;
  clientUserId?: string;
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
}

export function UhmMusicRoomPlayer({
  channel,
  clientUserId,
  isOpen,
  onClose,
  onOpen,
}: UhmMusicRoomPlayerProps) {
  const { t } = useTranslation();

  // Playback state
  const [currentTrack, setCurrentTrack] = useState<SongQueueItem | null>(null);
  const [queue, setQueue] = useState<SongQueueItem[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(80);
  const [isMuted, setIsMuted] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [isApiReady, setIsApiReady] = useState(false);

  // Refs for callbacks and event handlers
  const playerRef = useRef<any>(null);
  const ytContainerRef = useRef<HTMLDivElement>(null);
  const currentTrackRef = useRef<SongQueueItem | null>(null);
  currentTrackRef.current = currentTrack;
  const queueRef = useRef<SongQueueItem[]>([]);
  queueRef.current = queue;
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const lastAutoNextTimeRef = useRef(0);

  // Determine if current user is Host / Room Controller (The Only One Who Plays Audio!)
  const isHost = useMemo(() => {
    if (!channel || !clientUserId) return false;
    const createdById = (channel.data?.created_by as any)?.id || (channel.data as any)?.created_by_id;
    if (createdById === clientUserId) return true;
    const member = channel.state?.members?.[clientUserId] as any;
    if (
      member?.channel_role === 'owner' ||
      member?.channel_role === 'admin' ||
      member?.role === 'owner' ||
      member?.role === 'admin'
    ) {
      return true;
    }
    return false;
  }, [channel, clientUserId]);

  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;

  // 1. Load YouTube IFrame API Script dynamically (ONLY FOR HOST)
  useEffect(() => {
    if (!isHost) return;

    if (window.YT && window.YT.Player) {
      setIsApiReady(true);
      return;
    }

    const prevOnReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prevOnReady) prevOnReady();
      setIsApiReady(true);
    };

    if (!document.getElementById('yt-iframe-api-script')) {
      const tag = document.createElement('script');
      tag.id = 'yt-iframe-api-script';
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag?.parentNode?.insertBefore(tag, firstScriptTag);
    }
  }, [isHost]);

  // 2. Initialize YouTube Player instance (ONLY HOST PLAYS AUDIO!)
  const initPlayer = useCallback(
    (videoId: string) => {
      if (!isHostRef.current) return;
      if (!window.YT || !window.YT.Player) return;

      const container = ytContainerRef.current;
      if (!container) return;

      if (playerRef.current && typeof playerRef.current.loadVideoById === 'function') {
        try {
          playerRef.current.loadVideoById({
            videoId,
            startSeconds: 0,
          });
          playerRef.current.unMute();
          playerRef.current.setVolume(volume || 100);
          playerRef.current.playVideo();
          return;
        } catch (e) {
          console.warn('Error loading video by id, recreating player:', e);
          try {
            playerRef.current?.destroy();
          } catch (_) {}
          playerRef.current = null;
        }
      }

      container.innerHTML = '<div id="uhm-music-yt-frame-inner" style="width:100%;height:100%"></div>';

      try {
        playerRef.current = new window.YT.Player('uhm-music-yt-frame-inner', {
          height: '100%',
          width: '100%',
          videoId,
          playerVars: {
            autoplay: 1,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            enablejsapi: 1,
          },
          events: {
            onReady: (event: any) => {
              try {
                event.target.setVolume(volume || 100);
                event.target.unMute();
                event.target.playVideo();
              } catch (e) {
                console.warn('Autoplay prevented onReady:', e);
              }
            },
            onStateChange: (event: any) => {
              // State 0 = ENDED: Automatically advance to next song
              if (event.data === 0) {
                const now = Date.now();
                if (now - lastAutoNextTimeRef.current > 2500) {
                  lastAutoNextTimeRef.current = now;
                  handleNextSong(true);
                }
              } else if (event.data === 1) {
                setIsPlaying(true);
              } else if (event.data === 2) {
                setIsPlaying(false);
              }
            },
            onError: (event: any) => {
              console.warn('YouTube Player error code:', event.data);
            },
          },
        });
      } catch (e) {
        console.error('Failed to instantiate YouTube Player:', e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [volume]
  );

  // 3. Auto-initialize player on Host when API is ready and a track exists
  useEffect(() => {
    if (isHost && isApiReady && currentTrack?.videoId && !playerRef.current) {
      initPlayer(currentTrack.videoId);
    }
  }, [isHost, isApiReady, currentTrack?.videoId, initPlayer]);

  // 4. Action: Play next song from queue
  const handleNextSong = useCallback(
    (broadcast: boolean = true) => {
      const currentQueue = queueRef.current;
      if (currentQueue.length === 0) {
        setCurrentTrack(null);
        setIsPlaying(false);
        setIsExpanded(false);
        if (broadcast && channel && isHostRef.current) {
          channel
            .sendEvent({
              type: 'music.control',
              action: 'PAUSE',
              currentTime: 0,
              timestamp: Date.now(),
            } as any)
            .catch(console.error);
        }
        return;
      }

      const [nextSong, ...remainingQueue] = currentQueue;
      setCurrentTrack(nextSong);
      setQueue(remainingQueue);
      setIsPlaying(true);

      // ONLY Host plays audio through their speakers
      if (isHostRef.current) {
        if (playerRef.current && typeof playerRef.current.loadVideoById === 'function') {
          try {
            playerRef.current.loadVideoById({
              videoId: nextSong.videoId,
              startSeconds: 0,
            });
            playerRef.current.unMute();
            playerRef.current.setVolume(volume || 100);
            playerRef.current.playVideo();
          } catch (e) {
            console.warn('Error playing next video on host:', e);
          }
        } else {
          initPlayer(nextSong.videoId);
        }

        // Host broadcasts the new playing track to all members
        if (broadcast && channel) {
          channel
            .sendEvent({
              type: 'music.control',
              action: 'PLAY',
              videoId: nextSong.videoId,
              title: nextSong.title,
              requestedBy: nextSong.requestedBy,
              currentTime: 0,
              queue: remainingQueue,
              timestamp: Date.now(),
            } as any)
            .catch(console.error);
        }
      } else if (broadcast && channel) {
        // If a member clicks Next button, request Host to skip
        channel
          .sendEvent({
            type: 'music.control',
            action: 'NEXT',
            timestamp: Date.now(),
          } as any)
          .catch(console.error);
      }
    },
    [channel, initPlayer, volume]
  );

  // 5. Action: Toggle Play/Pause
  const handleTogglePlay = useCallback(
    (broadcast: boolean = true) => {
      if (!currentTrack) {
        if (queue.length > 0) {
          handleNextSong(broadcast);
        }
        return;
      }

      if (isPlaying) {
        setIsPlaying(false);
        if (isHostRef.current) {
          try {
            playerRef.current?.pauseVideo();
          } catch (e) {}
          if (broadcast && channel) {
            channel
              .sendEvent({
                type: 'music.control',
                action: 'PAUSE',
                currentTime: playerRef.current?.getCurrentTime() || 0,
                timestamp: Date.now(),
              } as any)
              .catch(console.error);
          }
        } else if (broadcast && channel) {
          channel
            .sendEvent({
              type: 'music.control',
              action: 'PAUSE',
              timestamp: Date.now(),
            } as any)
            .catch(console.error);
        }
      } else {
        setIsPlaying(true);
        if (isHostRef.current) {
          setIsMuted(false);
          if (playerRef.current) {
            try {
              playerRef.current.unMute();
              playerRef.current.setVolume(volume || 100);
              playerRef.current.playVideo();
            } catch (e) {}
          } else {
            initPlayer(currentTrack.videoId);
          }
          if (broadcast && channel) {
            channel
              .sendEvent({
                type: 'music.control',
                action: 'PLAY',
                videoId: currentTrack.videoId,
                title: currentTrack.title,
                requestedBy: currentTrack.requestedBy,
                currentTime: playerRef.current?.getCurrentTime() || 0,
                timestamp: Date.now(),
              } as any)
              .catch(console.error);
          }
        } else if (broadcast && channel) {
          channel
            .sendEvent({
              type: 'music.control',
              action: 'PLAY',
              timestamp: Date.now(),
            } as any)
            .catch(console.error);
        }
      }
    },
    [channel, currentTrack, queue, isPlaying, volume, handleNextSong, initPlayer]
  );

  // 6. Action: Remove song from queue
  const handleRemoveFromQueue = useCallback(
    (indexToRemove: number) => {
      if (!channel) return;
      const updatedQueue = queue.filter((_, idx) => idx !== indexToRemove);
      setQueue(updatedQueue);
      channel
        .sendEvent({
          type: 'music.control',
          action: 'QUEUE_UPDATE',
          queue: updatedQueue,
          timestamp: Date.now(),
        } as any)
        .catch(console.error);
    },
    [channel, queue]
  );

  // 7. Host Speaker Volume & Mute Controls
  const handleToggleMute = useCallback(() => {
    if (!playerRef.current) return;
    if (isMuted) {
      playerRef.current.unMute();
      setIsMuted(false);
    } else {
      playerRef.current.mute();
      setIsMuted(true);
    }
  }, [isMuted]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setVolume(val);
    if (playerRef.current) {
      playerRef.current.setVolume(val);
      if (val > 0 && isMuted) {
        playerRef.current.unMute();
        setIsMuted(false);
      }
    }
  }, [isMuted]);

  // 8. Real-time Event Subscription (Channel Custom Events)
  useEffect(() => {
    if (!channel) return;

    const handleChannelEvent = (event: any) => {
      if (event.type !== 'music.control') return;
      const control = event as MusicControlEvent;

      // Handle member commands sent via UI to Host
      if (isHostRef.current) {
        if (control.action === 'NEXT') {
          handleNextSong(true);
          return;
        }
        if (control.action === 'PAUSE' && isPlayingRef.current) {
          handleTogglePlay(true);
          return;
        }
        if (control.action === 'PLAY' && !control.videoId && !isPlayingRef.current) {
          handleTogglePlay(true);
          return;
        }
      }

      // Handle Queue sync for everyone
      if (control.action === 'QUEUE_UPDATE' && Array.isArray(control.queue)) {
        setQueue(control.queue);
      } else if (control.action === 'PLAY') {
        if (control.videoId) {
          const track: SongQueueItem = {
            id: `${control.videoId}-${control.timestamp}`,
            videoId: control.videoId,
            title: control.title || 'YouTube Video',
            requestedBy: control.requestedBy || t('music.host_badge'),
            addedAt: control.timestamp,
          };
          setCurrentTrack(track);
          setIsPlaying(true);
          if (control.queue) setQueue(control.queue);

          // ONLY Host plays audio on their device
          if (isHostRef.current) {
            if (playerRef.current && typeof playerRef.current.loadVideoById === 'function') {
              try {
                playerRef.current.loadVideoById({
                  videoId: control.videoId,
                  startSeconds: control.currentTime || 0,
                });
                playerRef.current.unMute();
                playerRef.current.setVolume(volume || 100);
                playerRef.current.playVideo();
              } catch (e) {
                console.warn('Error switching video on host:', e);
              }
            } else {
              initPlayer(control.videoId);
            }
          }
        }
      } else if (control.action === 'PAUSE') {
        setIsPlaying(false);
        if (isHostRef.current) {
          try {
            playerRef.current?.pauseVideo();
          } catch (e) {}
        }
      } else if (control.action === 'REQUEST_SYNC') {
        if (isHostRef.current && currentTrackRef.current) {
          const currentTime = playerRef.current?.getCurrentTime() || 0;
          channel
            .sendEvent({
              type: 'music.control',
              action: 'SYNC_STATE',
              videoId: currentTrackRef.current.videoId,
              title: currentTrackRef.current.title,
              requestedBy: currentTrackRef.current.requestedBy,
              currentTime,
              isPlaying: isPlayingRef.current,
              queue: queueRef.current,
              timestamp: Date.now(),
            } as any)
            .catch(console.error);
        }
      } else if (control.action === 'SYNC_STATE' && !isHostRef.current) {
        if (control.queue) setQueue(control.queue);
        if (control.videoId) {
          const track: SongQueueItem = {
            id: `${control.videoId}-${control.timestamp}`,
            videoId: control.videoId,
            title: control.title || 'YouTube Video',
            requestedBy: control.requestedBy || t('music.host_badge'),
            addedAt: control.timestamp,
          };
          setCurrentTrack(track);
          setIsPlaying(!!control.isPlaying);
        }
      }
    };

    const sub = channel.on(handleChannelEvent);
    return () => {
      sub.unsubscribe();
    };
  }, [channel, handleNextSong, handleTogglePlay, initPlayer, t, volume]);

  // 9. Listen to incoming chat: English Commands (/start, /stop, /next, /play) & YouTube links
  useEffect(() => {
    if (!channel) return;

    const handleNewMessage = async (event: any) => {
      const rawText = (event.message?.text || '').trim();
      const cmd = rawText.toLowerCase();
      const senderName = event.message?.user?.name || event.message?.user?.id || 'Thành viên';

      // 1. Command /next, next, /skip, skip (English only)
      if (cmd === '/next' || cmd === 'next' || cmd === '/skip' || cmd === 'skip') {
        handleNextSong(true);
        toast.info(t('music.cmd_next', { name: senderName }));
        return;
      }

      // 2. Command /stop, stop (English only)
      if (cmd === '/stop' || cmd === 'stop') {
        if (isPlayingRef.current) {
          handleTogglePlay(true);
        }
        toast.info(t('music.cmd_stop', { name: senderName }));
        return;
      }

      // 3. Command /start, start, /play, play (English only)
      if (cmd === '/start' || cmd === 'start' || cmd === '/play' || cmd === 'play') {
        if (currentTrackRef.current && !isPlayingRef.current) {
          handleTogglePlay(true);
        } else if (!currentTrackRef.current && queueRef.current.length > 0) {
          handleNextSong(true);
        } else if (currentTrackRef.current && isPlayingRef.current) {
          toast.info(t('music.now_playing') + ': ' + currentTrackRef.current.title);
          return;
        } else {
          toast.info(t('music.empty_queue'));
          return;
        }
        toast.info(t('music.cmd_start', { name: senderName }));
        return;
      }

      // 4. Check for YouTube link in text (Anyone can contribute songs to the queue!)
      const videoId = extractYouTubeVideoId(rawText);
      if (!videoId) return;

      onOpen?.();

      const info = await fetchYouTubeVideoInfo(videoId);
      const newSong: SongQueueItem = {
        id: `${videoId}-${Date.now()}`,
        videoId,
        title: info.title,
        thumbnailUrl: info.thumbnailUrl,
        requestedBy: senderName,
        requestedByUserId: event.message?.user?.id,
        addedAt: Date.now(),
      };

      toast.success(t('music.song_added_toast', { title: newSong.title }));

      // If nothing is playing, play immediately (Host speaker plays audio)
      if (!currentTrackRef.current) {
        setCurrentTrack(newSong);
        setIsPlaying(true);
        if (isHostRef.current) {
          if (playerRef.current && typeof playerRef.current.loadVideoById === 'function') {
            try {
              playerRef.current.loadVideoById({
                videoId: newSong.videoId,
                startSeconds: 0,
              });
              playerRef.current.unMute();
              playerRef.current.setVolume(volume || 100);
              playerRef.current.playVideo();
            } catch (e) {}
          } else {
            initPlayer(newSong.videoId);
          }
        }
      } else {
        // If already playing, add to shared room queue
        setQueue((prev) => [...prev, newSong]);
      }
    };

    const sub = channel.on('message.new', handleNewMessage);
    return () => {
      sub.unsubscribe();
    };
  }, [channel, handleNextSong, handleTogglePlay, initPlayer, t, volume]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try {
        playerRef.current?.destroy();
      } catch (e) {
        // Ignore destroy error
      }
      playerRef.current = null;
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div className="w-full bg-white/95 dark:bg-[#13111c]/95 backdrop-blur-md border-b border-zinc-200/80 dark:border-zinc-800/80 shadow-sm transition-all duration-300 z-10">
      {/* Top Banner Row */}
      <div className="flex items-center justify-between px-4 py-2.5 gap-3">
        {/* Left Section: Video screen for Host OR Cover Art for Members */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {isHost ? (
            /* HOST ONLY: Mounts YouTube Player & Outputs Audio to Office Speaker */
            <div
              className={`transition-all duration-300 overflow-hidden shrink-0 ${
                currentTrack
                  ? isExpanded
                    ? 'w-64 sm:w-80 aspect-video rounded-xl shadow-md border border-zinc-200/80 dark:border-zinc-800 relative bg-zinc-900'
                    : 'w-36 sm:w-44 aspect-video rounded-xl shadow-md border border-zinc-200/80 dark:border-zinc-800 relative bg-zinc-900'
                  : 'w-0 h-0 opacity-0 pointer-events-none absolute -left-[9999px] -top-[9999px]'
              }`}
              style={{
                backgroundImage: currentTrack?.thumbnailUrl ? `url(${currentTrack.thumbnailUrl})` : undefined,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            >
              <div ref={ytContainerRef} className="w-full h-full" />
            </div>
          ) : (
            /* MEMBERS ONLY: Displays Song Cover Art (No audio playback on member devices!) */
            currentTrack ? (
              <div className="w-11 h-11 rounded-xl overflow-hidden shadow-sm border border-zinc-200/80 dark:border-zinc-800 shrink-0 bg-zinc-100 dark:bg-zinc-800">
                {currentTrack.thumbnailUrl ? (
                  <img
                    src={currentTrack.thumbnailUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-violet-600 text-white">
                    <Music className="w-4 h-4" />
                  </div>
                )}
              </div>
            ) : null
          )}

          {/* Standby Icon when idle */}
          {!currentTrack && (
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-500 flex items-center justify-center text-white shadow-sm shrink-0">
              <Music className="w-4 h-4" />
            </div>
          )}

          {/* Song Info & Speaker State */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate max-w-[280px] sm:max-w-md">
                {currentTrack ? currentTrack.title : t('music.idle')}
              </h4>
              {isHost ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-950/60 text-violet-700 dark:text-violet-300 shrink-0">
                  <Sparkles className="w-2.5 h-2.5" />
                  {t('music.host_badge')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0">
                  <Speaker className="w-2.5 h-2.5" />
                  {t('music.host_speaker')}
                </span>
              )}
            </div>

            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate flex items-center gap-1.5 mt-0.5">
              {currentTrack ? (
                <>
                  <span>{t('music.added_by', { name: currentTrack.requestedBy })}</span>
                  <span>•</span>
                  <span>{isPlaying ? t('music.now_playing') : t('music.paused')}</span>
                </>
              ) : (
                <span>{t('music.send_link_hint')}</span>
              )}
            </p>
          </div>
        </div>

        {/* Center / Right: Controls (Anyone can control /start, /stop, /next!) */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Play/Pause & Next Controls (Community Jukebox) */}
          <div className="flex items-center gap-1.5 bg-zinc-100 dark:bg-zinc-800/80 p-1 rounded-xl">
            <button
              onClick={() => handleTogglePlay(true)}
              disabled={!currentTrack && queue.length === 0}
              className="p-1.5 rounded-lg hover:bg-white dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 disabled:opacity-40 transition-colors"
              title={isPlaying ? t('music.pause') : t('music.play')}
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
            </button>

            <button
              onClick={() => handleNextSong(true)}
              disabled={queue.length === 0}
              className="p-1.5 rounded-lg hover:bg-white dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 disabled:opacity-40 transition-colors"
              title={t('music.next_song')}
            >
              <SkipForward className="w-4 h-4" />
            </button>
          </div>

          {/* Volume Control ONLY FOR HOST (Controls the speaker audio level) */}
          {isHost && (
            <div className="hidden sm:flex items-center gap-1.5 pl-1">
              <button
                onClick={handleToggleMute}
                className="p-1.5 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 rounded-lg transition-colors"
                title={isMuted ? t('music.unmute') : t('music.mute')}
              >
                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-16 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-violet-600"
              />
            </div>
          )}

          {/* Toggle Queue Button (View & contribute to shared playlist) */}
          <button
            onClick={() => setShowQueue(!showQueue)}
            className={`relative p-1.5 rounded-lg transition-colors ${
              showQueue
                ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300'
                : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
            }`}
            title={t('music.queue_title', { count: queue.length })}
          >
            <ListMusic className="w-4 h-4" />
            {queue.length > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full bg-violet-600 text-[9px] font-bold text-white">
                {queue.length}
              </span>
            )}
          </button>

          {/* Host Video Screen Toggle (Only visible for Host when a song is playing) */}
          {isHost && currentTrack && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-1.5 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 rounded-lg transition-colors"
              title={isExpanded ? 'Thu nhỏ video' : 'Xem video'}
            >
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}

          {/* Close Music Room Banner */}
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Queue Drawer */}
      {showQueue && (
        <div className="border-t border-zinc-200/60 dark:border-zinc-800/60 bg-zinc-50/70 dark:bg-zinc-900/50 p-3 max-h-60 overflow-y-auto">
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-200/50 dark:border-zinc-800/50">
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              {t('music.queue_title', { count: queue.length })}
            </span>
            <span className="text-[11px] text-zinc-400">
              {t('music.community_hint')}
            </span>
          </div>

          {queue.length === 0 ? (
            <div className="py-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
              {t('music.empty_queue')}
            </div>
          ) : (
            <div className="space-y-1.5">
              {queue.map((item, idx) => (
                <div
                  key={item.id || idx}
                  className="flex items-center justify-between gap-2.5 p-2 rounded-xl bg-white dark:bg-zinc-800/60 border border-zinc-200/50 dark:border-zinc-700/40 text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span className="text-[11px] font-bold text-zinc-400 w-4 text-center">
                      {idx + 1}
                    </span>
                    {item.thumbnailUrl && (
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        className="w-8 h-8 rounded-lg object-cover shrink-0"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-zinc-800 dark:text-zinc-200 truncate">
                        {item.title}
                      </p>
                      <p className="text-[10px] text-zinc-400 truncate">
                        {t('music.added_by', { name: item.requestedBy })}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => handleRemoveFromQueue(idx)}
                    className="p-1 text-zinc-400 hover:text-red-500 rounded-md transition-colors"
                    title={t('music.remove_from_queue')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
