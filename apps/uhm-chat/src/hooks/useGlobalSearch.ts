import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ErmisChat, Channel } from '@ermis-network/ermis-chat-sdk'

// ── Types ────────────────────────────────────────────────────────

export interface TopicResult {
  topic: Channel
  parentName: string
  parentImage?: string
}

export interface UseGlobalSearchReturn {
  // Section 1 — local instant
  myChannels: Channel[]
  // Section 2 — local instant
  topics: TopicResult[]
  // Section 3 — API debounced
  publicChannels: any[]
  isSearchingPublic: boolean
  // Section 4 — API validation-gated
  users: any[]
  isSearchingUsers: boolean
  userSearchHint: string | null
  // Actions
  selectPublicChannel: (channelData: any) => Promise<Channel>
  selectOrCreateDM: (targetUserId: string) => Promise<Channel>
}

// ── Validation & Normalization helpers ───────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_REGEX = /^\+?\d{9,15}$/

function isValidEmailOrPhone(term: string): boolean {
  return EMAIL_REGEX.test(term) || PHONE_REGEX.test(term)
}

function normalizeSearchText(str: string): string {
  if (!str) return ''
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

// ── Debounce constants ───────────────────────────────────────────

const PUBLIC_DEBOUNCE_MS = 400
const PUBLIC_MIN_CHARS = 2
const USER_DEBOUNCE_MS = 500

// ── Hook ─────────────────────────────────────────────────────────

/**
 * Reactive hook that provides multi-source global search across
 * local channels/topics and remote public channels/users.
 *
 * @param client - ErmisChat singleton instance
 * @param searchTerm - Current search input value
 */
export function useGlobalSearch(
  client: ErmisChat | null | undefined,
  searchTerm: string,
): UseGlobalSearchReturn {
  const term = searchTerm.trim().toLowerCase()
  const currentUserId = client?.userID

  // ── API result states ──────────────────────────────────────────
  const [publicChannels, setPublicChannels] = useState<any[]>([])
  const [isSearchingPublic, setIsSearchingPublic] = useState(false)
  const [users, setUsers] = useState<any[]>([])
  const [isSearchingUsers, setIsSearchingUsers] = useState(false)

  // Refs for cleanup
  const publicTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Section 1: My Channels (local instant) ─────────────────────
  const myChannels = useMemo(() => {
    if (!client || !term) return []
    const normalizedTerm = normalizeSearchText(term)

    return Object.values(client.activeChannels).filter((ch) => {
      // Exclude topic channels
      if (ch.type === 'topic') return false
      const name = normalizeSearchText((ch.data?.name as string) || '')
      return name.includes(normalizedTerm)
    })
  }, [client, term])

  // ── Section 2: Topics (local instant) ──────────────────────────
  const topics = useMemo<TopicResult[]>(() => {
    if (!client || !term) return []
    const results: TopicResult[] = []
    const normalizedTerm = normalizeSearchText(term)

    Object.values(client.activeChannels).forEach((ch) => {
      if (
        ch.type !== 'team' ||
        !ch.data?.topics_enabled ||
        !ch.state?.topics ||
        ch.state.topics.length === 0
      ) return

      const parentName = (ch.data?.name as string) || ch.cid
      const parentImage = ch.data?.image as string | undefined

      ch.state.topics.forEach((topic: Channel) => {
        const topicName = normalizeSearchText((topic.data?.name as string) || '')
        if (topicName.includes(normalizedTerm)) {
          results.push({ topic, parentName, parentImage })
        }
      })
    })

    return results
  }, [client, term])

  // ── Section 3: Public Channels (API debounced) ─────────────────
  useEffect(() => {
    if (publicTimerRef.current) {
      clearTimeout(publicTimerRef.current)
      publicTimerRef.current = null
    }

    if (!client || term.length < PUBLIC_MIN_CHARS) {
      setPublicChannels([])
      setIsSearchingPublic(false)
      return
    }

    setIsSearchingPublic(true)
    let cancelled = false

    publicTimerRef.current = setTimeout(async () => {
      try {
        const response = await client.searchPublicChannel(searchTerm.trim())
        if (!cancelled) {
          const items = (response as any)?.search_result?.channels || (response as any)?.channels || []
          setPublicChannels(items)
        }
      } catch (err) {
        console.error('[useGlobalSearch] Public channel search error:', err)
        if (!cancelled) setPublicChannels([])
      } finally {
        if (!cancelled) setIsSearchingPublic(false)
      }
    }, PUBLIC_DEBOUNCE_MS)

    return () => {
      cancelled = true
      if (publicTimerRef.current) {
        clearTimeout(publicTimerRef.current)
        publicTimerRef.current = null
      }
    }
  }, [client, term, searchTerm])

  // ── Section 4: Users (API validation-gated) ────────────────────
  const userSearchHint = useMemo(() => {
    if (!term) return null
    if (isValidEmailOrPhone(searchTerm.trim())) return null
    return 'search.user_hint' // i18n key
  }, [term, searchTerm])

  useEffect(() => {
    if (userTimerRef.current) {
      clearTimeout(userTimerRef.current)
      userTimerRef.current = null
    }

    const rawTerm = searchTerm.trim()
    if (!client || !rawTerm || !isValidEmailOrPhone(rawTerm)) {
      setUsers([])
      setIsSearchingUsers(false)
      return
    }

    setIsSearchingUsers(true)
    let cancelled = false

    userTimerRef.current = setTimeout(async () => {
      try {
        const response = await client.searchUsers(1, 25, rawTerm)
        if (!cancelled) {
          // Filter out current user from results
          const filtered = (response?.data || []).filter(
            (u: any) => u.id !== currentUserId,
          )
          setUsers(filtered)
        }
      } catch (err) {
        console.error('[useGlobalSearch] User search error:', err)
        if (!cancelled) setUsers([])
      } finally {
        if (!cancelled) setIsSearchingUsers(false)
      }
    }, USER_DEBOUNCE_MS)

    return () => {
      cancelled = true
      if (userTimerRef.current) {
        clearTimeout(userTimerRef.current)
        userTimerRef.current = null
      }
    }
  }, [client, searchTerm, currentUserId])

  // ── Actions ────────────────────────────────────────────────────

  const selectPublicChannel = useCallback(
    async (channelData: any): Promise<Channel> => {
      if (!client) throw new Error('Client not available')

      const cid = channelData.cid
      if (client.activeChannels[cid]) {
        return client.activeChannels[cid]
      }

      // Channel ID in Ermis SDK is the part after the first colon in the CID
      const type = channelData.type || 'team'
      const id = cid.substring(cid.indexOf(':') + 1)

      const channel = client.channel(type, id)
      await channel.watch()
      return channel
    },
    [client],
  )

  const selectOrCreateDM = useCallback(
    async (targetUserId: string): Promise<Channel> => {
      if (!client || !currentUserId) throw new Error('Client not available')

      // 1. Check existing DM in activeChannels
      const existing = Object.values(client.activeChannels).find((ch) => {
        if (ch.type !== 'messaging' || !ch.state?.members) return false
        const memberIds = Object.keys(ch.state.members)
        return (
          memberIds.length === 2 &&
          memberIds.includes(currentUserId) &&
          memberIds.includes(targetUserId)
        )
      })
      if (existing) return existing

      // 2. Create new DM (same pattern as CreateChannelModal)
      let dm = client.channel('messaging', {
        members: [currentUserId, targetUserId],
      } as any)
      const response = (await dm.create()) as any
      if (response?.channel?.id) {
        dm = client.channel('messaging', response.channel.id)
        await dm.watch()
      }
      return dm
    },
    [client, currentUserId],
  )

  return {
    myChannels,
    topics,
    publicChannels,
    isSearchingPublic,
    users,
    isSearchingUsers,
    userSearchHint,
    selectPublicChannel,
    selectOrCreateDM,
  }
}
