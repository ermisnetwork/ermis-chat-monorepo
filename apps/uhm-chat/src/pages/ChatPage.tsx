import { ChannelList, Channel, VirtualMessageList, MessageInput, ChannelHeader } from '@ermis-network/ermis-chat-react'
import { SidebarHeader } from '@/components/SidebarHeader'

export function ChatPage() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:via-[#0a0a0c] dark:to-zinc-900">
      
      {/* Sidebar */}
      <div className="w-[340px] border-r border-zinc-200/50 dark:border-zinc-800/50 h-full flex flex-col bg-white/60 dark:bg-zinc-950/60 backdrop-blur-xl z-20 shadow-[1px_0_10px_rgba(0,0,0,0.02)] shrink-0">
        <SidebarHeader />
        <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-zinc-300 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-thumb]:rounded-full">
          <ChannelList />
        </div>
      </div>
      
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative min-w-0">
        <Channel>
          {/* Background pattern layer */}
          <div className="absolute inset-0 bg-chat-pattern pointer-events-none opacity-[0.03] dark:opacity-[0.05]"></div>
          
          <div className="relative z-10 bg-white/70 dark:bg-zinc-950/70 backdrop-blur-md border-b border-zinc-200/50 dark:border-zinc-800/50 shadow-sm">
            <ChannelHeader />
          </div>

          <div className="flex-1 overflow-y-auto relative z-10">
            <VirtualMessageList />
          </div>
          
          {/* Message Input Floating Card */}
          <div className="p-4 pb-6 relative z-10">
            <div className="max-w-4xl mx-auto">
              <div className="rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800/50 overflow-hidden">
                <MessageInput />
              </div>
            </div>
          </div>
        </Channel>
      </div>
    </div>
  )
}
