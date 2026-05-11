import React from 'react'
import type { MessageRendererProps } from '@ermis-network/ermis-chat-react'
import { useChatClient, useCallContext } from '@ermis-network/ermis-chat-react'
import { parseSignalMessage, CallType } from '@ermis-network/ermis-chat-sdk'
import { Video, Phone } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export const UhmSignalMessage: React.FC<MessageRendererProps> = ({ message, signalMessageTranslations }) => {
  const { client, activeChannel } = useChatClient()
  const callContext = useCallContext()
  const { t } = useTranslation()

  const rawText = message.text ?? ''
  const result = rawText ? parseSignalMessage(rawText, client.userID || '', signalMessageTranslations) : null

  if (!result) {
    return (
      <span className="ermis-message-list__signal-text">
        {rawText}
      </span>
    )
  }

  const isVideo = result.callType === CallType.VIDEO
  const isFailed = result.color === '#FF4842'
  const textColorClass = isFailed ? 'text-red-500' : 'text-[#10b981]'

  return (
    <div className="flex flex-col min-w-[200px] bg-white dark:bg-zinc-900 rounded-lg shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="p-3">
        <div className={`${textColorClass} font-medium text-[15px] mb-2 leading-tight`}>
          {result.text}
        </div>
        <div className="flex items-center text-zinc-700 dark:text-zinc-300 gap-2">
          {isVideo ? (
            <Video className={`w-[18px] h-[18px] ${textColorClass}`} />
          ) : (
            <Phone className={`w-[18px] h-[18px] ${textColorClass}`} />
          )}
          <span className="text-[14px] leading-tight">
            {result.duration ? result.duration : (isVideo ? t('actions.video_call') : t('actions.audio_call'))}
          </span>
        </div>
      </div>
      <div className="h-[1px] bg-zinc-200 dark:bg-zinc-800 w-full" />
      <button
        className="w-full text-center py-2 text-blue-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors font-medium text-[14px]"
        onClick={() => {
          if (activeChannel?.cid && callContext) {
            callContext.createCall(isVideo ? 'video' : 'audio', activeChannel.cid)
          }
        }}
      >
        {t('actions.call_back', 'Gọi lại')}
      </button>
    </div>
  )
}
