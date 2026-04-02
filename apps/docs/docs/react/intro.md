---
sidebar_position: 1
---

# Getting Started with React UI Kit

The `@ermis-network/ermis-chat-react` package provides ready-to-use, highly customizable React components for building chat applications. It depends tightly on the core SDK for state management and API communication.

## Installation

```bash
yarn add @ermis-network/ermis-chat-react @ermis-network/ermis-chat-sdk 
```

## Setup Code

Wrap your application or route with the `<Chat />` provider. You must pass a client instance.

```tsx
import { useEffect, useState } from 'react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import { Chat, ChannelList, Channel, MessageList, MessageInput } from '@ermis-network/ermis-chat-react';

// Optional: import default styling
import '@ermis-network/ermis-chat-react/styles/index.css';

const chatClient = ErmisChat.getInstance('YOUR_API_KEY', 'YOUR_PROJECT_ID', 'API_URL');

export default function ChatApp() {
   const [clientReady, setClientReady] = useState(false);

   useEffect(() => {
       const setupClient = async () => {
           await chatClient.connectUser({ id: 'react_user' }, 'JWT_TOKEN');
           setClientReady(true);
       };
       setupClient();

       return () => {
           chatClient.disconnectUser();
       }
   }, []);

   if (!clientReady) return <div>Loading...</div>;

   return (
       <Chat client={chatClient}>
           <div className="layout">
               <ChannelList />
               <Channel>
                   <MessageList />
                   <MessageInput />
               </Channel>
           </div>
       </Chat>
   );
}
```
