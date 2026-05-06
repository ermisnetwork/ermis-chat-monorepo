import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useCallContext } from '@ermis-network/ermis-chat-react'
import { CallStatus } from '@ermis-network/ermis-chat-sdk'
import { 
  Phone, 
  PhoneOff, 
  Video as VideoIcon, 
  VideoOff, 
  Mic, 
  MicOff, 
  MonitorUp, 
  Maximize, 
  Minimize, 
  AlertCircle,
  ChevronDown
} from 'lucide-react'
import { Avatar } from '@ermis-network/ermis-chat-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** Format seconds into MM:SS */
const formatDuration = (totalSeconds: number): string => {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0')
  const s = (totalSeconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export const UhmCallUI: React.FC = () => {
  const { t } = useTranslation()
  const {
    callStatus,
    callType,
    callerInfo,
    receiverInfo,
    isIncoming,
    localStream,
    remoteStream,
    acceptCall,
    rejectCall,
    endCall,
    toggleMic,
    toggleVideo,
    isMicMuted,
    isVideoMuted,
    audioDevices,
    videoDevices,
    selectedAudioDeviceId,
    selectedVideoDeviceId,
    isScreenSharing,
    errorMessage,
    toggleScreenShare,
    switchAudioDevice,
    switchVideoDevice,
    clearError,
    isRemoteMicMuted,
    upgradeCall,
    callDuration,
  } = useCallContext()

  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const remoteAudioRef = useRef<HTMLAudioElement>(null)
  const ringingAudioRef = useRef<HTMLAudioElement>(null)
  const callContainerRef = useRef<HTMLDivElement>(null)

  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toggleFullscreen = useCallback(() => {
    if (!callContainerRef.current) return
    if (!document.fullscreenElement) {
      callContainerRef.current.requestFullscreen?.().catch(() => { })
    } else {
      document.exitFullscreen?.().catch(() => { })
    }
  }, [])

  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handleChange)
    return () => document.removeEventListener('fullscreenchange', handleChange)
  }, [])

  // Handle ringing audio
  useEffect(() => {
    if (callStatus === CallStatus.RINGING && ringingAudioRef.current) {
      const audioPath = isIncoming ? '/call_incoming.mp3' : '/call_outgoing.mp3'
      ringingAudioRef.current.src = audioPath
      ringingAudioRef.current.loop = true
      ringingAudioRef.current.play().catch((e) => console.log('Audio play blocked:', e))
    } else if (ringingAudioRef.current) {
      ringingAudioRef.current.pause()
      ringingAudioRef.current.currentTime = 0
    }
  }, [callStatus, isIncoming])

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream, callType, callStatus])

  useEffect(() => {
    if (remoteStream) {
      if (callType === 'video' && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream
      }
    }
  }, [remoteStream, callType, callStatus])

  // Auto-hide controls for video calls
  const handleMouseMove = useCallback(() => {
    if (callType !== 'video' || callStatus !== CallStatus.CONNECTED) return
    setShowControls(true)
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000)
  }, [callType, callStatus])

  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    }
  }, [])

  if (!callStatus && !errorMessage) return null

  const peerInfo = isIncoming ? callerInfo : receiverInfo
  const isVideo = callType === 'video'
  const isConnected = callStatus === CallStatus.CONNECTED
  const isRinging = callStatus === CallStatus.RINGING

  // 1. Error View
  if (errorMessage) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
        <div className="bg-white dark:bg-[#1a1828] rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-200">
          <div className="p-8 text-center">
            <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
              {t('chat.call.error')}
            </h3>
            <p className="text-zinc-500 dark:text-zinc-400 mb-8">
              {errorMessage}
            </p>
            <button
              onClick={clearError}
              className="w-full py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-semibold rounded-2xl transition-colors active:scale-95"
            >
              {t('actions.confirm_cancel')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 2. Ringing View
  if (isRinging) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
        <audio ref={ringingAudioRef} hidden />
        <div className="bg-[#1a1828] text-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden relative border border-white/5 animate-in zoom-in-95 duration-300">
          <div className="flex flex-col items-center py-12 px-8 text-center">
            {/* Pulsing Avatar */}
            <div className="relative mb-8">
              <div className="absolute inset-0 bg-indigo-500/20 rounded-full animate-ping" />
              <div className="relative">
                <Avatar
                  image={peerInfo?.avatar}
                  name={peerInfo?.name}
                  size={100}
                  className="ring-4 ring-indigo-500/30 shadow-2xl"
                />
              </div>
            </div>

            <h2 className="text-2xl font-bold mb-2 tracking-tight">
              {peerInfo?.name || t('chat.menu_profile_anonymous')}
            </h2>
            <p className="text-indigo-300 font-medium animate-pulse mb-12">
              {isIncoming ? t('chat.call.calling_you') : t('chat.call.ringing')}
            </p>

            <div className="flex gap-10">
              {isIncoming ? (
                <>
                  <div className="flex flex-col items-center gap-2">
                    <button
                      onClick={rejectCall}
                      className="w-14 h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-lg shadow-red-500/40 transition-all hover:scale-110 active:scale-90"
                    >
                      <PhoneOff className="w-6 h-6 text-white" />
                    </button>
                    <span className="text-xs font-medium text-zinc-400">{t('actions.call.decline')}</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <button
                      onClick={acceptCall}
                      className="w-14 h-14 bg-emerald-500 hover:bg-emerald-600 rounded-full flex items-center justify-center shadow-lg shadow-emerald-500/40 transition-all hover:scale-110 active:scale-90"
                    >
                      {isVideo ? <VideoIcon className="w-6 h-6 text-white" /> : <Phone className="w-6 h-6 text-white" />}
                    </button>
                    <span className="text-xs font-medium text-zinc-400">{t('actions.call.accept')}</span>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <button
                    onClick={endCall}
                    className="w-14 h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-lg shadow-red-500/40 transition-all hover:scale-110 active:scale-90"
                  >
                    <PhoneOff className="w-6 h-6 text-white" />
                  </button>
                  <span className="text-xs font-medium text-zinc-400">{t('actions.call.end')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // 3. Active Call View
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 md:p-8">
      <div
        ref={callContainerRef}
        className={`relative w-full overflow-hidden bg-[#0d0c15] text-white shadow-2xl transition-all duration-500 ${isVideo
            ? (isFullscreen ? 'fixed inset-0' : 'max-w-5xl aspect-video rounded-[2rem] border border-white/5')
            : 'max-w-md aspect-[4/5] rounded-[2.5rem] border border-white/5'
          }`}
        onMouseMove={handleMouseMove}
      >
        {/* ── Video Layers ── */}
        {isVideo && (
          <>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
            {/* Remote Mic Muted Indicator */}
            {isRemoteMicMuted && (
              <div className="absolute top-6 left-6 bg-red-500/80 backdrop-blur-md rounded-full px-3 py-1 flex items-center gap-2 shadow-lg ring-1 ring-white/10 z-20">
                <MicOff className="w-4 h-4 text-white" />
              </div>
            )}
            <div className="absolute top-6 right-6 w-32 md:w-48 aspect-video bg-zinc-900 rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10 z-20">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover mirror"
              />
            </div>
          </>
        )}

        {/* ── Audio View ── */}
        {!isVideo && (
          <div className="h-full flex flex-col items-center justify-center animate-in fade-in zoom-in duration-500 px-8">
            <div className="relative mb-10">
              <div className="absolute inset-0 rounded-full border-2 border-indigo-500/20 scale-125 animate-[ping_2s_infinite]" />
              <Avatar
                image={peerInfo?.avatar}
                name={peerInfo?.name}
                size={140}
                className="ring-4 ring-indigo-500/50 shadow-[0_0_50px_rgba(99,102,241,0.3)]"
              />
              {/* Remote Mic Muted Indicator for Audio */}
              {isRemoteMicMuted && (
                <div className="absolute bottom-1 right-1 bg-red-500 rounded-full p-2 shadow-xl ring-4 ring-[#0d0c15] animate-in zoom-in-50 duration-300">
                  <MicOff className="w-5 h-5 text-white" />
                </div>
              )}
            </div>
            <h2 className="text-3xl font-bold tracking-tight mb-4 text-center">{peerInfo?.name}</h2>
            <div className="flex items-center gap-2 text-indigo-300/80 font-mono text-lg bg-indigo-500/10 px-4 py-1 rounded-full border border-indigo-500/20">
              <div className="w-2 h-2 bg-indigo-400 rounded-full animate-pulse" />
              {formatDuration(callDuration)}
            </div>

            <audio ref={remoteAudioRef} autoPlay className="hidden" />
          </div>
        )}

        {/* ── Floating Controls ── */}
        <div
          className={`absolute bottom-8 left-1/2 -translate-x-1/2 z-30 transition-all duration-300 transform ${showControls ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'
            } w-full px-4 flex justify-center`}
        >
          <div className="flex items-center gap-3 md:gap-4 p-2 bg-zinc-900/90 backdrop-blur-2xl rounded-full ring-1 ring-white/10 shadow-2xl">
            {/* Mic Group */}
            <div className={`flex items-center h-11 md:h-12 rounded-full overflow-hidden transition-all duration-300 ${isMicMuted ? 'bg-red-500' : 'bg-white/10 hover:bg-white/15'}`}>
              <button
                onClick={toggleMic}
                className="h-full pl-4 pr-2 flex items-center justify-center transition-all active:scale-90"
                title={isMicMuted ? t('actions.call.unmute') : t('actions.call.mute')}
              >
                {isMicMuted ? <MicOff className="w-5 h-5 text-white" /> : <Mic className="w-5 h-5 text-white" />}
              </button>
              
              <div className={`w-px h-6 transition-colors ${isMicMuted ? 'bg-white/20' : 'bg-white/10'}`} />
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="h-full pl-1 pr-3 flex items-center justify-center transition-all hover:bg-black/10 active:scale-90 text-white/80 hover:text-white">
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-64 bg-[#1a1828] border-white/10 text-white z-[10001]" side="top" align="center" sideOffset={12}>
                  <DropdownMenuLabel className="text-zinc-400 font-medium px-3 py-2 text-xs uppercase tracking-wider">{t('actions.call.audio_devices')}</DropdownMenuLabel>
                  <DropdownMenuSeparator className="bg-white/5" />
                  <DropdownMenuRadioGroup value={selectedAudioDeviceId} onValueChange={switchAudioDevice}>
                    {audioDevices.map((device) => (
                      <DropdownMenuRadioItem 
                        key={device.deviceId} 
                        value={device.deviceId}
                        className="focus:bg-indigo-500 focus:text-white cursor-pointer py-2.5 px-3 rounded-lg mx-1"
                      >
                        {device.label || `Microphone ${device.deviceId.slice(0, 5)}`}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Video Group */}
            <div className={`flex items-center h-11 md:h-12 rounded-full overflow-hidden transition-all duration-300 ${isVideo && isVideoMuted ? 'bg-red-500' : 'bg-white/10 hover:bg-white/15'}`}>
              <button
                onClick={isVideo ? toggleVideo : upgradeCall}
                className="h-full pl-4 pr-2 flex items-center justify-center transition-all active:scale-90"
                title={isVideo ? (isVideoMuted ? t('actions.call.video_on') : t('actions.call.video_off')) : t('actions.call.upgrade')}
              >
                {isVideo && isVideoMuted ? <VideoOff className="w-5 h-5 text-white" /> : <VideoIcon className="w-5 h-5 text-white" />}
              </button>

              <div className={`w-px h-6 transition-colors ${isVideo && isVideoMuted ? 'bg-white/20' : 'bg-white/10'}`} />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="h-full pl-1 pr-3 flex items-center justify-center transition-all hover:bg-black/10 active:scale-90 text-white/80 hover:text-white">
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-64 bg-[#1a1828] border-white/10 text-white z-[10001]" side="top" align="center" sideOffset={12}>
                  <DropdownMenuLabel className="text-zinc-400 font-medium px-3 py-2 text-xs uppercase tracking-wider">{t('actions.call.video_devices')}</DropdownMenuLabel>
                  <DropdownMenuSeparator className="bg-white/5" />
                  <DropdownMenuRadioGroup value={selectedVideoDeviceId} onValueChange={switchVideoDevice}>
                    {videoDevices.length > 0 ? (
                      videoDevices.map((device) => (
                        <DropdownMenuRadioItem 
                          key={device.deviceId} 
                          value={device.deviceId}
                          className="focus:bg-indigo-500 focus:text-white cursor-pointer py-2.5 px-3 rounded-lg mx-1"
                        >
                          {device.label || `Camera ${device.deviceId.slice(0, 5)}`}
                        </DropdownMenuRadioItem>
                      ))
                    ) : (
                      <div className="px-3 py-4 text-center text-zinc-500 text-sm">No cameras found</div>
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Screen Share (Desktop only) */}
            {isVideo && (
              <button
                onClick={toggleScreenShare}
                className={`w-11 h-11 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all active:scale-90 ${isScreenSharing ? 'bg-indigo-500 text-white shadow-lg' : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                title={isScreenSharing ? t('actions.call.screen_stop') : t('actions.call.screen_share')}
              >
                <MonitorUp className="w-5 h-5" />
              </button>
            )}

            {/* Fullscreen */}
            {isVideo && (
              <button
                onClick={toggleFullscreen}
                className="w-11 h-11 md:w-12 md:h-12 bg-white/10 text-white hover:bg-white/20 rounded-full flex items-center justify-center transition-all active:scale-90"
                title={isFullscreen ? t('actions.call.exit_fullscreen') : t('actions.call.fullscreen')}
              >
                {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </button>
            )}

            {/* End Call */}
            <div className="w-px h-6 bg-white/10 mx-1" />

            <button
              onClick={endCall}
              className="w-11 h-11 md:w-12 md:h-12 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105 active:scale-90"
              title={t('actions.call.end')}
            >
              <PhoneOff className="w-5 h-5 text-white" />
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .mirror { transform: scaleX(-1); }
        @keyframes ping {
          75%, 100% {
            transform: scale(1.5);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  )
}

UhmCallUI.displayName = 'UhmCallUI'
