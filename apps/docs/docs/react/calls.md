---
sidebar_position: 4
sidebar_label: Calls
---

# Audio & Video Calls

Ermis Chat React provides a complete, built-in Direct Call system for 1-on-1 audio and video calls. It integrates seamlessly with the chat UI through the `ChatProvider`, `ErmisCallProvider`, and `ErmisCallUI` components.

---

## Prerequisites

Before using the call feature, you **must** run the initialization command to copy the required WebAssembly and audio files into your application's `public/` directory.

```bash
npx ermis-init-call
```

This copies the following files from the SDK into your project's `public/` folder:

| File | Purpose |
|------|---------|
| `ermis_call_node_wasm_bg.wasm` | WebRTC WASM engine (required) |
| `call_incoming.mp3` | Ringtone for incoming calls (optional) |
| `call_outgoing.mp3` | Ringtone for outgoing calls (optional) |

:::caution
If you skip this step, call initialization will fail at runtime because the WASM module cannot be loaded. Always run `npx ermis-init-call` after installing or updating the SDK.
:::

:::tip
For non-standard setups (e.g., assets served from a CDN), you can manually place the files wherever you want and override paths via `callWasmPath`, `incomingCallAudioPath`, and `outgoingCallAudioPath` props on `ChatProvider`.
:::

---

## Quick Start

The fastest way to enable calls is through `ChatProvider`:

```tsx
import { ChatProvider, ChannelList, Channel, VirtualMessageList, MessageInput } from '@ermis-network/ermis-chat-react';
import '@ermis-network/ermis-chat-react/dist/css/index.css';

function App() {
  return (
    <ChatProvider
      client={chatClient}
      enableCall={true}
      callSessionId="unique-session-id"
      onCallEnd={(duration) => console.log(`Call ended after ${duration}s`)}
    >
      <ChannelList />
      <Channel>
        {/* ChannelHeader automatically shows call buttons */}
        <VirtualMessageList />
        <MessageInput />
      </Channel>
    </ChatProvider>
  );
}
```

That's it! The `ChannelHeader` component will automatically display audio and video call buttons, and the `ErmisCallUI` modal handles the entire call lifecycle.

---

## ChatProvider Call Props

When `enableCall` is set to `true`, `ChatProvider` internally mounts `ErmisCallProvider` and `ErmisCallUI`. You can configure both through these props:

### Configuration

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `enableCall` | `boolean` | `false` | Enables the call feature. |
| `callSessionId` | `string` | — | **Required.** Unique session ID for the call node. |
| `callWasmPath` | `string` | `'/ermis_call_node_wasm_bg.wasm'` | Path to the WASM module in your public directory. |
| `callRelayUrl` | `string` | `'https://iroh-relay.ermis.network:8443'` | Relay server URL for NAT traversal. |
| `CallUIComponent` | `React.ComponentType` | `ErmisCallUI` | Replace the entire default call UI. |
| `incomingCallAudioPath` | `string` | `'/call_incoming.mp3'` | Audio file for incoming call ringtone. |
| `outgoingCallAudioPath` | `string` | `'/call_outgoing.mp3'` | Audio file for outgoing call ringtone. |

### Lifecycle Callbacks

| Prop | Type | Description |
|------|------|-------------|
| `onCallStart` | `(callType: 'audio' \| 'video', cid: string) => void` | Called when the local user initiates a call. |
| `onCallEnd` | `(duration: number) => void` | Called when a call ends (duration in seconds). |
| `onCallError` | `(error: string) => void` | Called when a call error occurs. |
| `onIncomingCall` | `(callerInfo: UserCallInfo) => void` | Called when an incoming call is received. |
| `onCallAccepted` | `() => void` | Called when the local user accepts a call. |
| `onCallRejected` | `() => void` | Called when the local user rejects a call. |

**Example: Analytics & Notifications**

```tsx
<ChatProvider
  client={chatClient}
  enableCall={true}
  callSessionId={sessionId}
  onCallStart={(type, cid) => {
    analytics.track('call_started', { type, channelId: cid });
  }}
  onCallEnd={(duration) => {
    analytics.track('call_ended', { duration });
  }}
  onCallError={(error) => {
    toast.error(`Call failed: ${error}`);
  }}
  onIncomingCall={(caller) => {
    // Show a system notification
    new Notification(`${caller.name} is calling you`);
  }}
>
  {children}
</ChatProvider>
```

---

## `<ErmisCallUI />`

The default call UI component that renders the full call experience — ringing screen, active call (audio/video), and error states.

If you use `ChatProvider` with `enableCall`, this component is mounted automatically. You only need to render it manually if you're building a custom integration with `ErmisCallProvider` directly.

### Core Configs

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `className` | `string` | — | Additional CSS class name on the root element. |
| `suppressIncomingCalls` | `boolean` | `false` | If `true`, hides the incoming call UI. Useful for "Do Not Disturb" mode. |
| `onCallDurationChange` | `(seconds: number) => void` | — | Called every second with the current call duration. |
| `incomingCallAudioPath` | `string` | `'/call_incoming.mp3'` | Audio file for incoming call ringtone. |
| `outgoingCallAudioPath` | `string` | `'/call_outgoing.mp3'` | Audio file for outgoing call ringtone. |

### Icon Overrides

Every icon in the call UI can be replaced with a custom component:

| Prop | Type | Description |
|------|------|-------------|
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Avatar shown during ringing and audio call. |
| `MicIcon` | `React.ComponentType` | Microphone on icon. |
| `MicOffIcon` | `React.ComponentType` | Microphone muted icon. |
| `VideoIcon` | `React.ComponentType` | Camera on icon. |
| `VideoOffIcon` | `React.ComponentType` | Camera off icon. |
| `PhoneIcon` | `React.ComponentType` | Phone icon (accept/reject/end). |
| `ScreenShareIcon` | `React.ComponentType` | Screen sharing active icon. |
| `ScreenShareOffIcon` | `React.ComponentType` | Screen sharing inactive icon. |
| `FullscreenIcon` | `React.ComponentType` | Enter fullscreen icon. |
| `ExitFullscreenIcon` | `React.ComponentType` | Exit fullscreen icon. |
| `UpgradeCallIcon` | `React.ComponentType` | Upgrade call (audio → video) button icon. |

### Localization (I18n)

All text labels in the call UI can be overridden for internationalization:

| Prop | Type | Default |
|------|------|---------|
| `incomingCallTitle` | `(callType: string) => string` | `` (type) => `Incoming ${type} call` `` |
| `outgoingCallTitle` | `(callType: string) => string` | `` (type) => `Outgoing ${type} call` `` |
| `ongoingCallTitle` | `(callType: string) => string` | `` (type) => `Ongoing ${type} Call` `` |
| `isCallingYouLabel` | `string` | `'is calling you...'` |
| `ringingLabel` | `string` | `'Ringing...'` |
| `rejectCallLabel` | `string` | `'Reject'` |
| `acceptCallLabel` | `string` | `'Accept'` |
| `endCallLabel` | `string` | `'End Call'` |
| `cancelLabel` | `string` | `'Cancel'` |
| `toggleMicTitle` | `string` | `'Toggle Mic'` |
| `toggleVideoTitle` | `string` | `'Toggle Video'` |
| `shareScreenTitle` | `string` | `'Share Screen'` |
| `stopScreenShareTitle` | `string` | `'Stop Sharing'` |
| `connectedLabel` | `string` | `'Connected'` |
| `audioCallBadgeLabel` | `string` | `'Audio Call'` |
| `videoCallBadgeLabel` | `string` | `'Video Call'` |
| `fullscreenTitle` | `string` | `'Fullscreen'` |
| `exitFullscreenTitle` | `string` | `'Exit Fullscreen'` |
| `upgradeCallTitle` | `string` | `'Request Video Upgrade'` |

### Component Slots

For maximum flexibility, you can replace entire sections of the call UI:

| Prop | Type | Description |
|------|------|-------------|
| `RingingComponent` | `React.ComponentType<ErmisCallRingingProps>` | Replace the ringing/incoming call view. |
| `ConnectedAudioComponent` | `React.ComponentType<ErmisCallConnectedAudioProps>` | Replace the active audio call view. |
| `ConnectedVideoComponent` | `React.ComponentType<ErmisCallConnectedVideoProps>` | Replace the active video call view. |
| `ErrorComponent` | `React.ComponentType<ErmisCallErrorProps>` | Replace the error state view. |
| `ControlsBarComponent` | `React.ComponentType<ErmisCallControlsBarProps>` | Replace the controls bar (mic, video, screen share, etc). |

**Example: Custom Ringing Screen**

```tsx
import { ErmisCallUI } from '@ermis-network/ermis-chat-react';
import type { ErmisCallRingingProps } from '@ermis-network/ermis-chat-react';

const MyRingingScreen = ({ peerInfo, callType, isIncoming, acceptCall, rejectCall }: ErmisCallRingingProps) => (
  <div className="my-ringing-screen">
    <img src={peerInfo?.avatar} alt={peerInfo?.name} />
    <h2>{peerInfo?.name}</h2>
    <p>{isIncoming ? 'Incoming' : 'Outgoing'} {callType} call</p>
    {isIncoming && (
      <div>
        <button onClick={acceptCall}>Accept</button>
        <button onClick={rejectCall}>Decline</button>
      </div>
    )}
  </div>
);

// Usage
<ErmisCallUI RingingComponent={MyRingingScreen} />
```

**Example: Do Not Disturb Mode**

```tsx
const [isDND, setIsDND] = useState(false);

<ErmisCallUI suppressIncomingCalls={isDND} />
```

---

## `useCallContext` Hook

Access the full call state and actions from anywhere within the `ErmisCallProvider` tree.

```tsx
import { useCallContext } from '@ermis-network/ermis-chat-react';
```

### Returns: `CallContextValue`

| Property | Type | Description |
|----------|------|-------------|
| `callStatus` | `CallStatus \| ''` | Current status: `'ringing'`, `'connected'`, or `''`. |
| `callType` | `string` | Call type: `'audio'` or `'video'`. |
| `callDuration` | `number` | Duration in seconds (ticks every second while connected). |
| `callerInfo` | `UserCallInfo \| undefined` | Info about the caller (incoming calls). |
| `receiverInfo` | `UserCallInfo \| undefined` | Info about the receiver (outgoing calls). |
| `isIncoming` | `boolean` | Whether the current call is incoming. |
| `localStream` | `MediaStream \| null` | The local user's media stream. |
| `remoteStream` | `MediaStream \| null` | The remote peer's media stream. |
| `isMicMuted` | `boolean` | Whether the local microphone is muted. |
| `isVideoMuted` | `boolean` | Whether the local camera is off. |
| `isScreenSharing` | `boolean` | Whether screen sharing is active. |
| `isRemoteMicMuted` | `boolean` | Whether the remote peer's mic is muted. |
| `isRemoteVideoMuted` | `boolean` | Whether the remote peer's camera is off. |
| `errorMessage` | `string \| null` | Current error message, if any. |
| `audioDevices` | `MediaDeviceInfo[]` | Available audio input devices. |
| `videoDevices` | `MediaDeviceInfo[]` | Available video input devices. |
| `selectedAudioDeviceId` | `string` | Currently selected mic device ID. |
| `selectedVideoDeviceId` | `string` | Currently selected camera device ID. |

### Actions

| Method | Signature | Description |
|--------|-----------|-------------|
| `createCall` | `(type: 'audio' \| 'video', cid: string) => Promise<void>` | Initiate an outgoing call. |
| `acceptCall` | `() => Promise<void>` | Accept an incoming call. |
| `rejectCall` | `() => Promise<void>` | Reject an incoming call. |
| `endCall` | `() => Promise<void>` | End the current call. |
| `toggleMic` | `() => void` | Toggle microphone on/off. |
| `toggleVideo` | `() => void` | Toggle camera on/off. |
| `toggleScreenShare` | `() => Promise<void>` | Toggle screen sharing. |
| `upgradeCall` | `() => Promise<void>` | Upgrade audio call to video. |
| `switchAudioDevice` | `(deviceId: string) => Promise<void>` | Switch to a different microphone. |
| `switchVideoDevice` | `(deviceId: string) => Promise<void>` | Switch to a different camera. |
| `clearError` | `() => void` | Clear the current error message. |

**Example: Custom Call Header Badge**

```tsx
import { useCallContext } from '@ermis-network/ermis-chat-react';

const CallDurationBadge = () => {
  const { callStatus, callDuration, callType } = useCallContext();

  if (callStatus !== 'connected') return null;

  const mins = Math.floor(callDuration / 60).toString().padStart(2, '0');
  const secs = (callDuration % 60).toString().padStart(2, '0');

  return (
    <div className="call-badge">
      <span className="call-badge__dot" />
      {callType === 'video' ? '📹' : '📞'} {mins}:{secs}
    </div>
  );
};
```

**Example: Building a Completely Custom Call UI**

```tsx
import { useCallContext } from '@ermis-network/ermis-chat-react';

const MyCallUI = () => {
  const {
    callStatus, callType, isIncoming,
    callerInfo, receiverInfo,
    acceptCall, rejectCall, endCall,
    toggleMic, isMicMuted,
    toggleVideo, isVideoMuted,
    callDuration,
  } = useCallContext();

  if (!callStatus) return null;
  const peer = isIncoming ? callerInfo : receiverInfo;

  return (
    <div className="my-call-ui">
      <h2>{peer?.name}</h2>
      <p>Status: {callStatus} | Duration: {callDuration}s</p>

      {callStatus === 'ringing' && isIncoming && (
        <div>
          <button onClick={acceptCall}>Answer</button>
          <button onClick={rejectCall}>Decline</button>
        </div>
      )}

      {callStatus === 'connected' && (
        <div>
          <button onClick={toggleMic}>{isMicMuted ? 'Unmute' : 'Mute'}</button>
          <button onClick={toggleVideo}>{isVideoMuted ? 'Camera On' : 'Camera Off'}</button>
          <button onClick={endCall}>Hang Up</button>
        </div>
      )}
    </div>
  );
};
```

:::tip
When building a fully custom UI, set `CallUIComponent` on `ChatProvider` to your custom component so the default `ErmisCallUI` is not rendered.
:::

---

## Theming & CSS

The call UI uses CSS variables (tokens) for theming, defined in `_tokens.css`. Override these in your CSS to match your application's look and feel.

### Call UI Tokens

| Token | Dark Mode Default | Light Mode Default | Purpose |
|-------|-------------------|--------------------|---------|
| `--ermis-call-bg` | `linear-gradient(135deg, #0f0f1a, #1a1a2e, #16213e)` | `linear-gradient(135deg, #f8f9fa, #e9ecef, #dee2e6)` | Call modal background gradient. |
| `--ermis-call-glass` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.04)` | Glassmorphism control bar background. |
| `--ermis-call-glass-border` | `rgba(255,255,255,0.1)` | `rgba(0,0,0,0.08)` | Glassmorphism border. |
| `--ermis-call-pulse` | `rgba(99,102,241,0.4)` | `rgba(99,102,241,0.3)` | Ringing pulse animation color. |

### Signal Message Tokens

| Token | Dark Mode Default | Light Mode Default | Purpose |
|-------|-------------------|--------------------|---------|
| `--ermis-signal-success` | `#54D62C` | `#229A16` | Completed call icon/text color. |
| `--ermis-signal-missed` | `#FF4842` | `#B72136` | Missed/rejected call icon/text color. |
| `--ermis-signal-bg` | `rgba(255,255,255,0.04)` | `rgba(0,0,0,0.03)` | Signal message background. |
| `--ermis-signal-own-success` | `#86EFAC` | `#86EFAC` | Own completed call color. |
| `--ermis-signal-own-missed` | `#FCA5A5` | `#FCA5A5` | Own missed call color. |

**Example: Custom Theme Override**

```css
.ermis-chat--dark {
  --ermis-call-bg: linear-gradient(135deg, #1a0030, #2d0050);
  --ermis-call-pulse: rgba(147, 51, 234, 0.5);
  --ermis-signal-success: #10b981;
  --ermis-signal-missed: #ef4444;
}
```

### BEM Class Reference

All call UI elements follow BEM naming convention with the `ermis-call-ui` block:

| Class | Element |
|-------|---------|
| `.ermis-call-ui` | Root container |
| `.ermis-call-ui--fullscreen` | Fullscreen modifier |
| `.ermis-call-ui__ringing` | Ringing state container |
| `.ermis-call-ui__ringing-avatar` | Avatar with pulse rings |
| `.ermis-call-ui__ringing-actions` | Accept/reject buttons |
| `.ermis-call-ui__active` | Connected state container |
| `.ermis-call-ui__video-container` | Video call layout |
| `.ermis-call-ui__video-remote` | Remote video stream |
| `.ermis-call-ui__video-local` | Local video PiP |
| `.ermis-call-ui__audio-container` | Audio call layout |
| `.ermis-call-ui__controls` | Controls bar |
| `.ermis-call-ui__control-btn` | Individual control button |
| `.ermis-call-ui__control-btn--muted` | Muted state modifier |
| `.ermis-call-ui__control-btn--danger` | End call button |
| `.ermis-call-ui__timer` | Call duration display |
| `.ermis-call-ui__error` | Error state container |

---

## Signal Messages

When a call ends, the SDK automatically creates a **signal message** in the channel to record the call history. These messages display as inline call logs within the chat feed.

Signal messages are rendered by the `SignalMessage` component and show:
- Call type icon (audio/video)
- Call result text (e.g., "Audio call", "Missed audio call")
- Call duration (if the call was answered)

### Customizing Signal Messages

You can override the signal message renderer using the `messageRenderers` prop on `VirtualMessageList`:

```tsx
import { VirtualMessageList } from '@ermis-network/ermis-chat-react';
import type { MessageRendererProps } from '@ermis-network/ermis-chat-react';

const MySignalMessage = ({ message }: MessageRendererProps) => (
  <div className="my-call-log">
    📞 {message.text}
  </div>
);

<VirtualMessageList
  messageRenderers={{
    signal: MySignalMessage,
  }}
/>
```
