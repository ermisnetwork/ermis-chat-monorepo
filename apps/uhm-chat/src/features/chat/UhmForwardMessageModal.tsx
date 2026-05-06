import React, { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Send, Hash, Check, FileText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useChatClient,
  Avatar,
  removeAccents,
  isTopicChannel,
  isStickerMessage,
  isImage,
  isVideo,
} from '@ermis-network/ermis-chat-react'
import type { Channel } from '@ermis-network/ermis-chat-sdk'
import { createForwardMessagePayload } from '@ermis-network/ermis-chat-sdk'
import type { ForwardMessageModalProps } from '@ermis-network/ermis-chat-react'

/* ----------------------------------------------------------
   UhmForwardMessageModal
   A premium, branded forward modal for Uhm Chat.
   ---------------------------------------------------------- */
export function UhmForwardMessageModal({
  message,
  onDismiss,
}: ForwardMessageModalProps) {
  const { t } = useTranslation()
  const { client, activeChannel } = useChatClient()
  const [search, setSearch] = useState('')
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)

  /* --- Get all channels --- */
  const channels = useMemo(() => {
    return Object.values(client.activeChannels) as Channel[]
  }, [client.activeChannels])

  /* --- Smart Search logic --- */
  const filteredChannels = useMemo(() => {
    if (!search.trim()) return channels
    const q = search.toLowerCase()
    const cleanQ = removeAccents(q)
    const isStrict = q !== cleanQ

    return channels.filter((ch) => {
      const name = (ch.data?.name || ch.cid) as string
      const tName = name.toLowerCase()
      const cleanT = removeAccents(tName)

      const parentCid = ch.data?.parent_cid as string | undefined
      const parent = parentCid ? client.activeChannels[parentCid] : null
      const parentName = (parent?.data?.name || '') as string
      const ptName = parentName.toLowerCase()
      const cleanPT = removeAccents(ptName)

      if (isStrict) {
        return tName.includes(q) || ptName.includes(q)
      }
      return cleanT.includes(cleanQ) || cleanPT.includes(cleanQ)
    })
  }, [channels, search, client.activeChannels])

  /* --- Toggle selection --- */
  const toggleChannel = useCallback((cid: string) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev)
      if (next.has(cid)) next.delete(cid)
      else next.add(cid)
      return next
    })
  }, [])

  /* --- Send logic --- */
  const handleSend = useCallback(async () => {
    if (!activeChannel || selectedChannels.size === 0 || sending) return
    setSending(true)

    try {
      for (const cid of selectedChannels) {
        const targetChannel = channels.find((c) => c.cid === cid)
        if (!targetChannel) continue

        const forwardPayload = createForwardMessagePayload(
          message,
          targetChannel.cid as string,
          activeChannel.cid as string,
        )

        await activeChannel.forwardMessage(forwardPayload, {
          type: targetChannel.type,
          channelID: targetChannel.id!,
        })
      }
      onDismiss()
    } catch (err) {
      console.error('Failed to forward messages', err)
    } finally {
      setSending(false)
    }
  }, [activeChannel, selectedChannels, channels, message, sending, onDismiss])

  /* --- Message preview details --- */
  const previewText = message.text || ''
  const attachmentCount = message.attachments?.length ?? 0
  const isSticker = isStickerMessage(message)
  const stickerUrl = (message as any).sticker_url || (isSticker ? message.attachments?.[0]?.image_url : undefined)
  const firstImage = message.attachments?.find(isImage)
  const firstVideo = message.attachments?.find(isVideo)
  const previewImageUrl = stickerUrl || firstImage?.image_url || firstImage?.thumb_url || firstVideo?.thumb_url

  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent className="max-w-[440px] p-0 overflow-hidden bg-card border-zinc-200/50 dark:border-zinc-800/50 shadow-2xl rounded-2xl gap-0">
        <DialogHeader className="p-4 border-b border-zinc-100 dark:border-zinc-800/50">
          <DialogTitle className="text-lg font-bold tracking-tight">
            {t('forward.title', 'Forward Message')}
          </DialogTitle>
        </DialogHeader>

        {/* Message Preview */}
        <div className="p-4 bg-zinc-50/50 dark:bg-zinc-900/30 border-b border-zinc-100 dark:border-zinc-800/50">
          <div className="flex gap-3 p-3 rounded-xl bg-white dark:bg-[#1a1828] border border-zinc-200/50 dark:border-white/5 shadow-sm overflow-hidden">
            {previewImageUrl && (
              <div className="relative w-14 h-14 shrink-0 rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800">
                <img
                  src={previewImageUrl}
                  alt="Preview"
                  className="w-full h-full object-cover"
                />
                {isSticker && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/5">
                    <span className="text-[8px] font-bold text-white bg-black/40 px-1 rounded uppercase tracking-tighter">
                      Sticker
                    </span>
                  </div>
                )}
                {firstVideo && !isSticker && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <div className="w-5 h-5 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                      <div className="w-0 h-0 border-t-[4px] border-t-transparent border-l-[7px] border-l-white border-b-[4px] border-b-transparent ml-0.5" />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <span className="text-[11px] font-bold uppercase tracking-wider text-primary/70 truncate">
                {message.user?.name || message.user_id}
              </span>
              {previewText ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-300 line-clamp-2 leading-relaxed">
                  {previewText}
                </p>
              ) : isSticker ? (
                <p className="text-sm italic text-zinc-400 dark:text-zinc-500">
                  {t('chat.sticker', 'Sticker')}
                </p>
              ) : null}
              {attachmentCount > 0 && !isSticker && (
                <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-medium mt-0.5">
                  <FileText className="w-3.5 h-3.5" />
                  {t('forward.attachments', { count: attachmentCount })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="p-4">
          <div className="relative group">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-primary transition-colors" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('forward.search_placeholder', 'Search channels, topics...')}
              className="pl-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 border-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-all"
              autoFocus
            />
          </div>
        </div>

        {/* Channel List */}
        <div className="max-h-[300px] overflow-y-auto px-2 pb-4 space-y-0.5 custom-scrollbar">
          {filteredChannels.length === 0 ? (
            <div className="py-12 text-center flex flex-col items-center justify-center gap-2">
              <div className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800/50 flex items-center justify-center">
                <Search className="w-6 h-6 text-zinc-300 dark:text-zinc-600" />
              </div>
              <p className="text-sm text-zinc-400 font-medium">
                {t('forward.empty', 'No results found')}
              </p>
            </div>
          ) : (
            filteredChannels.map((ch) => {
              const isTopic = isTopicChannel(ch)
              const name = (ch.data?.name || ch.cid) as string
              const isSelected = selectedChannels.has(ch.cid)

              const parentCid = ch.data?.parent_cid as string | undefined
              const parent = parentCid ? client.activeChannels[parentCid] : null
              const parentName = (parent?.data?.name || '') as string

              const rawImage = ch.data?.image as string | undefined
              const isEmoji = rawImage?.startsWith('emoji://')
              const emojiStr = isEmoji ? rawImage!.replace('emoji://', '') : undefined

              return (
                <button
                  key={ch.cid}
                  onClick={() => toggleChannel(ch.cid)}
                  className={`w-full flex items-center gap-3 p-2.5 rounded-xl transition-all duration-200 group active:scale-[0.98] ${isSelected
                      ? 'bg-primary/10 dark:bg-primary/20'
                      : 'hover:bg-zinc-100 dark:hover:bg-white/5'
                    }`}
                >
                  <div className="relative shrink-0">
                    {isEmoji ? (
                      <div className="w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 flex items-center justify-center text-2xl">
                        {emojiStr}
                      </div>
                    ) : isTopic ? (
                      <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-primary/20 flex items-center justify-center text-primary font-bold">
                        <Hash className="w-5 h-5" />
                      </div>
                    ) : (
                      <Avatar
                        image={ch.data?.image as string}
                        name={name}
                        size={40}
                        className={ch.type === 'team' || ch.type === 'group' ? 'ermis-avatar-wrapper--group' : undefined}
                      />
                    )}
                    {isSelected && (
                      <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-primary text-white flex items-center justify-center shadow-lg border-2 border-white dark:border-[#1a1828] animate-in zoom-in duration-200">
                        <Check className="w-3 h-3 stroke-[3]" />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 text-left">
                    {isTopic && parentName && (
                      <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-0.5 truncate">
                        {parentName}
                      </div>
                    )}
                    <div className={`text-sm font-semibold truncate transition-colors ${isSelected ? 'text-primary' : 'text-zinc-700 dark:text-zinc-200'
                      }`}>
                      {name}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-zinc-50/50 dark:bg-zinc-900/30 border-t border-zinc-100 dark:border-zinc-800/50 flex items-center justify-end gap-3">
          <Button
            variant="ghost"
            onClick={onDismiss}
            className="rounded-xl font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
          >
            {t('forward.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={selectedChannels.size === 0 || sending}
            onClick={handleSend}
            className="rounded-xl min-w-[100px] font-bold shadow-lg shadow-primary/20 transition-all active:scale-95 bg-primary hover:bg-primary/90"
          >
            {sending ? (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t('forward.sending', 'Sending...')}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4" />
                {t('forward.send', 'Send')}
                {selectedChannels.size > 0 && (
                  <span className="ml-0.5 bg-white/20 px-1.5 py-0.5 rounded-md text-[10px]">
                    {selectedChannels.size}
                  </span>
                )}
              </div>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
