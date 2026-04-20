---
sidebar_position: 10
---

# Audio & Video Calls

The SDK supports 1-on-1 audio and video calls through the `ErmisCallNode` class. It uses a proprietary WebRTC WASM client for peer-to-peer media streaming, with the Ermis Relay infrastructure for NAT traversal and signaling.

---

## Prerequisites

Before using the call feature, you **must** run the initialization command to copy the required WebAssembly and audio files into your application's `public/` directory:

```bash
npx ermis-init-call
```

This CLI tool copies the following files from the SDK package into your project's `public/` folder:

| File | Required | Purpose |
|------|----------|---------|
| `ermis_call_node_wasm_bg.wasm` | ✅ Yes | Core WebRTC WASM engine — call will fail without this |
| `call_incoming.mp3` | Optional | Ringtone sound for incoming calls |
| `call_outgoing.mp3` | Optional | Ringtone sound for outgoing calls |

:::caution
If you skip this step, `ErmisCallNode` initialization will fail at runtime because the WASM module cannot be loaded. Always re-run `npx ermis-init-call` after updating the SDK to ensure you have the latest WASM binary.
:::

For custom deployments (e.g., assets served from a CDN), you can place the WASM file anywhere and pass the path via the `wasmPath` constructor parameter.

---

## Architecture Overview

The call system consists of three main classes:

| Class | Responsibility |
|-------|---------------|
| `ErmisCallNode` | High-level orchestrator — manages the call lifecycle, signaling, local/remote streams, and device management |
| `MediaStreamSender` | Encodes and transmits local audio/video frames to the remote peer via the WASM data channel |
| `MediaStreamReceiver` | Receives, decodes, and renders remote audio/video frames into a playable `MediaStream` |

```
┌──────────────────────────────────────────────────────┐
│                   ErmisCallNode                      │
│  (Lifecycle, Signaling, Device Management)           │
│                                                      │
│  ┌──────────────────┐    ┌───────────────────────┐   │
│  │ MediaStreamSender│    │ MediaStreamReceiver    │   │
│  │ (Encode + Send)  │───▶│ (Receive + Decode)    │   │
│  │  Audio: AAC      │    │  Audio: AudioContext   │   │
│  │  Video: HEVC     │    │  Video: VideoDecoder   │   │
│  └──────────────────┘    └───────────────────────┘   │
│           ▲                         │                │
│     localStream               remoteStream           │
└──────────────────────────────────────────────────────┘
              │                       │
         getUserMedia()        MediaStream (generated)
```

---

## Instantiating a Call Node

```typescript
import { ErmisCallNode } from '@ermis-network/ermis-chat-sdk';

const sessionID = 'unique-session-id';
const wasmPath = '/ermis_call_node_wasm_bg.wasm';
const relayUrl = 'https://iroh-relay.ermis.network:8443';

const callNode = new ErmisCallNode(chatClient, sessionID, wasmPath, relayUrl);
```

### Constructor Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `client` | `ErmisChat` | An initialized and connected `ErmisChat` client instance. |
| `sessionID` | `string` | Unique identifier for this call session. Used to differentiate between multiple devices/tabs of the same user. |
| `wasmPath` | `string` | Path to the `ermis_call_node_wasm_bg.wasm` file (usually in `public/`). |
| `relayUrl` | `string` | Ermis relay server URL for NAT traversal. |

On instantiation, the node:
1. Loads the WASM module
2. Subscribes to WebSocket `signal`, `connection.changed`, and `message.updated` events
3. Sets up a hardware device change listener

---

## Call Lifecycle

### Making a Call

```typescript
// type: 'audio' or 'video'
// cid: the channel ID (1-on-1 direct messaging channel)
await callNode.createCall('video', 'messaging:channel-id');
```

This sends a `CREATE_CALL` signal to the server, which dispatches it via WebSocket to the receiver's device. Internally, the node:
1. Gets a local WASM endpoint address
2. Starts the local media stream (mic + optional camera)
3. Initializes media encoders
4. Starts a 60-second miss-call timeout

### Accepting a Call

```typescript
await callNode.acceptCall();
```

Sends an `ACCEPT_CALL` signal to the server. The sender's node will then establish the peer-to-peer connection, and once connected, both sides receive their respective `onRemoteStream` callbacks.

### Rejecting a Call

```typescript
await callNode.rejectCall();
```

Sends a `REJECT_CALL` signal and destroys the local call instance, stopping all media tracks and cleaning up resources.

### Ending a Call

```typescript
await callNode.endCall();
```

Sends an `END_CALL` signal and performs a full cleanup — stops encoders/decoders, closes the WASM connection, and releases all media tracks.

---

## Event Callbacks

Register callbacks **before** making or receiving calls:

### Call Events

```typescript
// Incoming or outgoing call event
callNode.onCallEvent = (data: CallEventData) => {
  console.log(data.type);        // 'incoming' | 'outgoing'
  console.log(data.callType);    // 'audio' | 'video'
  console.log(data.callerInfo);  // { id, name, avatar }
  console.log(data.receiverInfo);
};

// Call status changes (ringing → connected → ended)
callNode.onCallStatus = (status: string | null) => {
  // status: 'ringing' | 'connected' | 'ended' | null
  updateUI(status);
};
```

### Media Streams

```typescript
// Local stream ready (camera/mic permissions resolved)
callNode.onLocalStream = (stream: MediaStream) => {
  myVideoElement.srcObject = stream;
};

// Remote stream ready (peer media decoded and playable)
callNode.onRemoteStream = (stream: MediaStream) => {
  peerVideoElement.srcObject = stream;
};
```

### Remote Peer State

```typescript
// Remote peer toggled their mic/camera
callNode.onDataChannelMessage = (state: { audio_enable?: boolean; video_enable?: boolean }) => {
  if (typeof state.audio_enable === 'boolean') {
    setRemoteMicMuted(!state.audio_enable);
  }
  if (typeof state.video_enable === 'boolean') {
    setRemoteCameraOff(!state.video_enable);
  }
};
```

### Error & Connection

```typescript
// Call errors (network issues, busy recipient, device errors)
callNode.onError = (error: string) => {
  showToast(error);
  // Possible messages:
  // - "Unable to make the call. Please check your network connection"
  // - "Recipient was busy"
  // - "No microphone or camera found. Please check your device."
};

// Network connection changes during a call
callNode.onConnectionMessageChange = (message: string | null) => {
  // message: "Your network connection is unstable" | null
};
```

### Call Upgrade & Screen Share

```typescript
// Remote peer upgraded the call (audio → video)
callNode.onUpgradeCall = (upgraderInfo: UserCallInfo) => {
  setCallType('video');
};

// Screen sharing state changed
callNode.onScreenShareChange = (isSharing: boolean) => {
  updateScreenShareButton(isSharing);
};
```

### Device Changes

```typescript
// Hardware devices plugged/unplugged
callNode.onDeviceChange = (audioDevices: MediaDeviceInfo[], videoDevices: MediaDeviceInfo[]) => {
  updateDeviceSelectors(audioDevices, videoDevices);
};
```

---

## Media Controls

### Toggle Microphone

```typescript
// enabled: true = unmute, false = mute
await callNode.toggleMic(true);
await callNode.toggleMic(false);
```

This enables/disables the audio track on the local stream and sends a `TransceiverState` message to the remote peer via the data channel.

### Toggle Camera

```typescript
await callNode.toggleCamera(true);
await callNode.toggleCamera(false);
```

Same behavior as `toggleMic` but for video tracks.

### Screen Sharing

Replaces the local video track with the user's screen contents:

```typescript
await callNode.startScreenShare();
```

When the user stops sharing (either programmatically or via the browser's built-in stop button), the SDK automatically reverts to the camera:

```typescript
await callNode.stopScreenShare();
```

:::note
Screen sharing requires `navigator.mediaDevices.getDisplayMedia` support. The `onScreenShareChange` callback fires when the sharing state changes.
:::

### Upgrading Audio to Video

Seamlessly upgrade an active audio call to a video call:

```typescript
// Sends UPGRADE_CALL signal + adds local camera track + starts video encoding
await callNode.upgradeCall();
```

The remote peer receives this via the `onUpgradeCall` callback and can choose to add their own camera.

To add your own camera to a call that was upgraded by the remote peer (without sending the upgrade signal again):

```typescript
await callNode.requestUpgradeCall(true);
```

---

## Hardware Devices

### Querying Available Devices

```typescript
const { audioDevices, videoDevices } = await callNode.getDevices();

// Returns cached results if already queried, otherwise queries the system
audioDevices.forEach(d => console.log(d.label, d.deviceId));
videoDevices.forEach(d => console.log(d.label, d.deviceId));
```

### Getting Current/Default Devices

```typescript
// Currently selected devices
const { audioDevice, videoDevice } = callNode.getSelectedDevices();

// System default devices (first available)
const { audioDevice, videoDevice } = callNode.getDefaultDevices();
```

### Switching Devices Mid-Call

```typescript
// Switch microphone — returns true on success
const success = await callNode.switchAudioDevice('device-id-123');

// Switch camera — returns true on success
const success = await callNode.switchVideoDevice('device-id-456');
```

The switch methods:
1. Validate the target device exists
2. Request a new media stream with the specific device
3. Replace the track in the local stream
4. Fire `onLocalStream` so your UI updates
5. Return `false` and fire `onError` if the device is not found

---

## Types Reference

### Enums

```typescript
enum CallAction {
  CREATE_CALL = 'create-call',
  ACCEPT_CALL = 'accept-call',
  SIGNAL_CALL = 'signal-call',
  CONNECT_CALL = 'connect-call',
  HEALTH_CALL = 'health-call',
  END_CALL = 'end-call',
  REJECT_CALL = 'reject-call',
  MISS_CALL = 'miss-call',
  UPGRADE_CALL = 'upgrade-call',
}

enum CallStatus {
  RINGING = 'ringing',
  ENDED = 'ended',
  CONNECTED = 'connected',
  ERROR = 'error',
}
```

### Data Types

```typescript
type CallEventData = {
  type: 'incoming' | 'outgoing';
  callType: string;                     // 'audio' | 'video'
  cid: string;                          // channel ID
  callerInfo: UserCallInfo | undefined;
  receiverInfo: UserCallInfo | undefined;
  metadata?: Object;
};

type UserCallInfo = {
  id: string;
  name?: string;
  avatar?: string;
};
```

### Callback Summary

| Callback | Signature | When It Fires |
|----------|-----------|---------------|
| `onCallEvent` | `(data: CallEventData) => void` | Incoming or outgoing call initiated |
| `onCallStatus` | `(status: string \| null) => void` | Status changes: ringing → connected → ended |
| `onLocalStream` | `(stream: MediaStream) => void` | Local camera/mic stream is ready |
| `onRemoteStream` | `(stream: MediaStream) => void` | Remote peer's stream is decoded and playable |
| `onDataChannelMessage` | `(data: any) => void` | Remote peer's transceiver state (mic/camera toggle) |
| `onUpgradeCall` | `(upgraderInfo: UserCallInfo) => void` | Remote peer upgraded the call to video |
| `onScreenShareChange` | `(isSharing: boolean) => void` | Screen sharing started or stopped |
| `onError` | `(error: string) => void` | Call error (network, device, busy) |
| `onConnectionMessageChange` | `(message: string \| null) => void` | Network quality warning |
| `onDeviceChange` | `(audio: MediaDeviceInfo[], video: MediaDeviceInfo[]) => void` | Hardware device plugged/unplugged |

---

## Multi-Device Handling

The SDK automatically handles scenarios where the same user is logged in on multiple devices or tabs:

- When a user initiates a call from **Device A**, any other device/tab (**Device B**) with a different `sessionID` will automatically destroy its call instance
- When a user accepts a call on **Device A**, all other devices automatically dismiss the ringing state

This is managed internally via the `sessionID` matching logic in the signal event handler.
