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
| `wasm_worker.worker.mjs` | ✅ Yes | Web Worker script that runs the WASM runtime off the Main Thread |
| `call_incoming.mp3` | Optional | Ringtone sound for incoming calls |
| `call_outgoing.mp3` | Optional | Ringtone sound for outgoing calls |

:::caution
If you skip this step, `ErmisCallNode` initialization will fail at runtime because the WASM module cannot be loaded. Always re-run `npx ermis-init-call` after updating the SDK to ensure you have the latest WASM binary.
:::

For custom deployments (e.g., assets served from a CDN), you can place the WASM file anywhere and pass the path via the `wasmPath` constructor parameter.

---

## Architecture Overview

The call system consists of four main classes:

| Class | Responsibility |
|-------|---------------|
| `ErmisCallNode` | High-level orchestrator — manages the call lifecycle, signaling, local/remote streams, and device management |
| `WasmWorkerProxy` | Main Thread proxy — forwards all WASM calls to a Web Worker via `postMessage` (zero-copy transfer) |
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
│           │                         ▲                │
│           ▼                         │                │
│  ┌──────────────────────────────────────────────┐    │
│  │         WasmWorkerProxy (Main Thread)        │    │
│  │    postMessage(RPC) ←→ Worker(WASM runtime)  │    │
│  └──────────────────────────────────────────────┘    │
│           ▲                         │                │
│     localStream               remoteStream           │
└──────────────────────────────────────────────────────┘
              │                       │
         getUserMedia()        MediaStream (generated)
```

:::note
WASM **never** runs on the Main Thread. The `WasmWorkerProxy` uses a dedicated Web Worker with static caching — the Worker script Blob URL and compiled `WebAssembly.Module` are fetched only once and reused across all subsequent calls for near-instant re-initialization.
:::

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `client` | `ErmisChat` | ✅ | An initialized and connected `ErmisChat` client instance. |
| `sessionID` | `string` | ✅ | Unique identifier for this call session. Used to differentiate between multiple devices/tabs of the same user. |
| `wasmPath` | `string` | ✅ | Path to the `ermis_call_node_wasm_bg.wasm` file (usually in `public/`). |
| `relayUrl` | `string` | ✅ | Ermis relay server URL for NAT traversal. |
| `workerPath` | `string` | No | Path to the WASM Worker script. Default: `'/wasm_worker.worker.mjs'`. Override when the worker is served from a CDN or non-standard path. |

On instantiation, the node:
1. Creates a `WasmWorkerProxy` — fetches and compiles the WASM module inside a Web Worker
2. Subscribes to WebSocket `signal`, `connection.changed`, and `message.updated` events
3. Sets up a hardware device change listener

:::tip
You can call `callNode.prefillUserInfo(cid)` before initiating a call to pre-populate `callerInfo` and `receiverInfo` — useful if your UI needs to display user names and avatars before the signal event arrives.
:::

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
};

// Network connection changes during a call
callNode.onConnectionMessageChange = (message: string | null) => {
  // message: "Your network connection is unstable" | null
  // message: "Camera not available, using audio only" (video call fallback)
};
```

#### Error Messages Reference

| Error String | Trigger Condition |
|-------------|-------------------|
| `'call_network_error'` | `createCall` failed due to network error (`ERR_NETWORK`). |
| `'call_recipient_busy'` | Recipient is already in another call (API code `20`). |
| `'call_failed'` | Any other API error (fallback message). |
| `'call_no_devices'` | No microphone or camera found on the device. |
| `'Selected microphone not found'` | `switchAudioDevice` called with an invalid device ID. |
| `'Failed to switch microphone'` | Exception while switching audio device. |
| `'Selected camera not found'` | `switchVideoDevice` called with an invalid device ID. |
| `'Failed to switch camera'` | Exception while switching video device. |

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

## Device Fallback Behavior

The SDK gracefully handles missing hardware:

- **Video call + no camera**: Automatically falls back to audio-only. The `onConnectionMessageChange` callback fires with `'Camera not available, using audio only'`. The call proceeds normally with audio.
- **Audio call + no microphone**: Fires `onError('call_no_devices')`. The call is not established.
- **Video call + no mic + no camera**: Fires `onError('call_no_devices')`. The call is not established.

:::tip
Always register `onError` and `onConnectionMessageChange` callbacks to surface hardware issues to your users.
:::

---

## Connection Health & Keep-Alive

Once a call is connected, the SDK maintains connection stability through two independent health check mechanisms:

| Mechanism | Interval | Transport | Purpose |
|-----------|----------|-----------|--------|
| **Server health** | Every 10 seconds | REST API (`HEALTH_CALL` signal) | Tells the server the call is still active (prevents server-side cleanup). |
| **Peer health** | Every 5 seconds | WebRTC data channel (`healthCall` frame) | Tells the remote peer the connection is alive (peer-to-peer keep-alive). |

When the user goes **offline**:
- All health intervals are cleared immediately
- `onConnectionMessageChange('Your network connection is unstable')` fires

When the user comes back **online**:
- Server health interval restarts automatically
- `onConnectionMessageChange(null)` fires (clears the warning)

---

## Codec & Media Pipeline

The SDK uses the [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) for encoding and decoding media streams.

### Encoding (Sender)

| Stream | Codec | Sample Rate | Bitrate | Notes |
|--------|-------|-------------|---------|-------|
| Audio | AAC (`mp4a.40.2`) | 48 kHz, mono | 128 kbps | Echo cancellation + noise suppression enabled |
| Video | HEVC (`hev1.1.6.L93.B0`) | 30 fps | 500 kbps | 640×360 default, hardware-accelerated, realtime latency mode |

### Decoding (Receiver)

| Stream | Decoder | Output |
|--------|---------|--------|
| Audio | `AudioDecoder` → `AudioContext` → `AudioBufferSourceNode` | `MediaStreamAudioDestinationNode` |
| Video | `VideoDecoder` → `MediaStreamTrackGenerator` | Video track added to `MediaStream` |

### Latency Management

- **Audio**: Max latency capped at 500ms. If buffer exceeds this, the scheduler resets to prevent audio drift.
- **Video**: Backpressure — if `decodeQueueSize > 5`, delta frames are dropped and the decoder waits for the next key frame.
- **Video Decoder Crash Recovery**: If `VideoDecoder` crashes, it auto-respawns after 1 second and waits for a key frame before resuming.
- **Key frames**: Automatically generated every 60 frames (~2 seconds). Can be force-requested by the receiver.

:::caution
The WebCodecs API (specifically `MediaStreamTrackProcessor` and `MediaStreamTrackGenerator`) requires a Chromium-based browser (Chrome, Edge, Brave). Firefox and Safari do not yet support these APIs.
:::

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
