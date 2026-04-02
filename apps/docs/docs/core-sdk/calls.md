---
sidebar_position: 8
---

# Audio & Video Calls

The SDK supports WebRTC audio and video calls through the `ErmisCallNode` class, driven by a proprietary WebRTC WASM client tailored for the Ermis infrastructure.

## Instantiating a Call Node

First you must initialize the `ErmisCallNode` locally. This handles hardware device allocation, signalling, and peer-to-peer data channels.

```typescript
import { ErmisCallNode } from '@ermis-network/ermis-chat-sdk';

const sessionID = 'unique-session-id';
const wasmPath = '/path/to/ermis_call_node.wasm';
const relayUrl = 'https://test-iroh.ermis.network:8443';

const callNode = new ErmisCallNode(chatClient, sessionID, wasmPath, relayUrl);
```

## Making and Managing Calls

The call node exposes explicit asynchronous methods to manipulate the lifecycle of the call.

### `createCall`
Dials an outbound call. This triggers a `CREATE_CALL` signal on the receiver's connected client.
```typescript
// type can be 'video' or 'audio'
await callNode.createCall('video', 'target_channel_id');
```

### `acceptCall` / `rejectCall` / `endCall`
Self-explanatory methods that dispatch the appropriate call resolution flags to the server to establish or destroy connections.

```typescript
await callNode.acceptCall();
await callNode.endCall();
```

## Media Tracks & Devices

The Node gives you callbacks to wire into your application UI to render native HTML5 `<video>` and `<audio>` objects.

### Streaming Callbacks
```typescript
// Triggers when your camera/mic permissions resolve
callNode.onLocalStream = (stream: MediaStream) => {
    myVideoElement.srcObject = stream;
};

// Triggers when the remote peer stream has been established
callNode.onRemoteStream = (stream: MediaStream) => {
    peerVideoElement.srcObject = stream;
};
```

### Hardware Devices
Query or switch between various system microphones and cameras.
```typescript
const { audioDevices, videoDevices } = await callNode.getDevices();
```
```typescript
callNode.onDeviceChange = (audioDevices, videoDevices) => {
   // Devices unplugged or plugged in
   updateUI(audioDevices, videoDevices);
}
```

## Mid-Call Operations

### Screen Sharing
Quickly swap the user's camera feed with their screen contents.
```typescript
await callNode.startScreenShare();

// Once done, rollback to user camera
await callNode.stopScreenShare();
```

### Upgrading Media
Upgrade an active audio call to a video call dynamically seamlessly.
```typescript
await callNode.upgradeCall();
```
