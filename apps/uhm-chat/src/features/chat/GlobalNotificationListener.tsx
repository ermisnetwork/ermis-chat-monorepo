import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatClient, isGroupChannel } from '@ermis-network/ermis-chat-react'
import { toast } from 'sonner'
import type { Event } from '@ermis-network/ermis-chat-sdk'

const sendBrowserNotification = (title: string, options?: NotificationOptions) => {
  if (!('Notification' in window)) return

  if (Notification.permission === 'granted') {
    new Notification(title, options)
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        new Notification(title, options)
      }
    })
  }
}

export function GlobalNotificationListener() {
  const { t } = useTranslation()
  const { client, activeChannel } = useChatClient()

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    if (!client) return

    const showNotification = (title: string, body?: string, type: 'info' | 'success' | 'error' | 'default' = 'default') => {
      if (document.hidden) {
        sendBrowserNotification(title, { body, icon: '/favicon.ico' })
      } else {
        if (type === 'success') toast.success(title, { description: body })
        else if (type === 'error') toast.error(title, { description: body })
        else if (type === 'info') toast.info(title, { description: body })
        else toast(title, { description: body })
      }
    }

    const getChannelName = (event: Event) => {
      if (event.channel?.name) return event.channel.name
      if (event.channel?.id) return event.channel.id
      if (event.cid && client.activeChannels[event.cid]) {
        const ch = client.activeChannels[event.cid]
        return ch.data?.name || ch.id
      }
      return 'Unknown'
    }

    const getUserName = (event: Event) => {
      return event.user?.name || event.user?.id || 'Someone'
    }

    const handleChannelDeleted = (event: Event) => {
      const channelName = getChannelName(event)
      showNotification(t('notifications.channel_deleted', { name: channelName }), undefined, 'error')
    }

    const handleInviteAccepted = (event: Event) => {
      if (event.user?.id === client.userID) return
      const userName = getUserName(event)
      const channelName = getChannelName(event)
      showNotification(t('notifications.invite_accepted', { name: userName, channel: channelName }), undefined, 'success')
    }

    const handleInviteRejected = (event: Event) => {
      if (event.user?.id === client.userID) return
      const userName = getUserName(event)
      const channelName = getChannelName(event)
      showNotification(t('notifications.invite_rejected', { name: userName, channel: channelName }), undefined, 'error')
    }

    const handleInviteSkipped = (event: Event) => {
      if (event.user?.id === client.userID) return
      const userName = getUserName(event)
      const channelName = getChannelName(event)
      showNotification(t('notifications.invite_skipped', { name: userName, channel: channelName }), undefined, 'info')
    }

    const handleNewMessage = (event: Event) => {
      // Don't toast for active channel unless document is hidden
      if (activeChannel?.cid === event.cid && !document.hidden) return
      
      // Don't toast our own messages
      if (event.user?.id === client.userID) return

      // Skip signal/system messages
      if (event.message?.type === 'signal' || event.message?.type === 'system') return

      const userName = getUserName(event)
      
      // Check if group or DM
      let isGroup = !!event.channel?.name
      if (event.cid && client.activeChannels[event.cid]) {
        const ch = client.activeChannels[event.cid]
        isGroup = isGroupChannel(ch)
      }

      const title = isGroup 
        ? t('notifications.message_new_group', { name: userName, channel: getChannelName(event) })
        : t('notifications.message_new_direct', { name: userName })
      
      showNotification(title, event.message?.text)
    }

    const handleMemberAdded = (event: Event) => {
      const isTargetMe = event.member?.user?.id === client.userID || event.member?.user_id === client.userID
      if (isTargetMe && event.user?.id !== client.userID) {
        const channelName = getChannelName(event)
        showNotification(t('notifications.member_added', { channel: channelName }), undefined, 'success')
      }
    }

    const handleMemberPromoted = (event: Event) => {
      const isTargetMe = event.member?.user?.id === client.userID || event.member?.user_id === client.userID
      if (isTargetMe) {
        const channelName = getChannelName(event)
        showNotification(t('notifications.member_promoted', { channel: channelName }), undefined, 'success')
      }
    }

    const handleMemberDemoted = (event: Event) => {
      const isTargetMe = event.member?.user?.id === client.userID || event.member?.user_id === client.userID
      if (isTargetMe) {
        const channelName = getChannelName(event)
        showNotification(t('notifications.member_demoted', { channel: channelName }), undefined, 'info')
      }
    }

    const handleMemberBanned = (event: Event) => {
      if (event.member?.user?.id === client.userID || event.member?.user_id === client.userID) {
        const channelName = getChannelName(event)
        showNotification(t('notifications.member_banned', { channel: channelName }), undefined, 'error')
      }
    }

    const handleMemberUnbanned = (event: Event) => {
      if (event.member?.user?.id === client.userID || event.member?.user_id === client.userID) {
        const channelName = getChannelName(event)
        showNotification(t('notifications.member_unbanned', { channel: channelName }), undefined, 'success')
      }
    }

    const listeners = [
      client.on('notification.channel_deleted', handleChannelDeleted),
      client.on('notification.invite_accepted', handleInviteAccepted),
      client.on('notification.invite_rejected', handleInviteRejected),
      client.on('notification.invite_messaging_skipped', handleInviteSkipped),
      client.on('message.new', handleNewMessage),
      client.on('member.added', handleMemberAdded),
      client.on('member.promoted', handleMemberPromoted),
      client.on('member.demoted', handleMemberDemoted),
      client.on('member.banned', handleMemberBanned),
      client.on('member.unbanned', handleMemberUnbanned)
    ]

    return () => {
      listeners.forEach(l => l.unsubscribe())
    }
  }, [client, activeChannel?.cid, t])

  return null
}
