import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { KeyRound, Loader2, LockOpen, RefreshCw, RotateCcw, ShieldPlus, X } from 'lucide-react'
import { useChatClient, useRecoveryPin } from '@ermis-network/ermis-chat-react'
import type { RecoveryRestoredMessage } from '@ermis-network/ermis-chat-react'
import type { Channel as ChannelType } from '@ermis-network/ermis-chat-sdk'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RECOVERY_PIN_CONFIG } from '@/utils/constants'

type RecoveryMode = 'unlock' | 'setup' | 'change' | 'restore'
type RecoveryDialogVariant = 'channel' | 'gate'

type UhmRecoveryPinDialogProps = {
  isOpen: boolean
  onClose: () => void
  channel: ChannelType | null | undefined
  variant?: RecoveryDialogVariant
  onSkip?: () => void
  onUnlocked?: () => void
}

type MlsRecoveryManager = {
  initialized?: boolean
  archiveCurrentEpoch?: (channelType: string, channelId: string) => Promise<void>
  getEpoch?: (cid: string) => number
}

const DIGITS_ONLY = /^\d+$/

const toErrorMessage = (err: unknown): string => (
  err instanceof Error ? err.message : String(err)
)

const getRestoredText = (plaintext: unknown): string => {
  if (typeof plaintext === 'string') return plaintext
  if (plaintext && typeof plaintext === 'object') {
    const text = (plaintext as { text?: unknown }).text
    if (typeof text === 'string') return text
    try {
      return JSON.stringify(plaintext)
    } catch {
      return ''
    }
  }
  return ''
}

export function UhmRecoveryPinDialog({
  isOpen,
  onClose,
  channel,
  variant = 'channel',
  onSkip,
  onUnlocked,
}: UhmRecoveryPinDialogProps) {
  const { t } = useTranslation()
  const { client } = useChatClient()
  const recovery = useRecoveryPin()
  const { refresh } = recovery
  const mlsManager = client?.mlsManager as MlsRecoveryManager | undefined
  const mlsInitialized = mlsManager?.initialized === true
  const isGate = variant === 'gate'
  const isE2eeChannel = channel?.data?.mls_enabled === true
  const currentEpoch = channel?.cid && typeof mlsManager?.getEpoch === 'function'
    ? mlsManager.getEpoch(channel.cid)
    : undefined

  const [mode, setMode] = useState<RecoveryMode>('unlock')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [oldPin, setOldPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [fromEpoch, setFromEpoch] = useState('')
  const [toEpoch, setToEpoch] = useState('')
  const [restored, setRestored] = useState<RecoveryRestoredMessage[] | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      setPin('')
      setConfirmPin('')
      setOldPin('')
      setNewPin('')
      setFromEpoch('')
      setToEpoch('')
      setRestored(null)
      setLocalError(null)
      return
    }

    if (mlsInitialized) {
      refresh()
    }
  }, [isOpen, mlsInitialized, refresh])

  useEffect(() => {
    if (isOpen && !isGate && recovery.hasRecoveryKey) {
      setMode('restore')
    }
  }, [isGate, isOpen, recovery.hasRecoveryKey])

  const validatePin = useCallback((value: string): string | null => {
    if (!value) return null
    if (!DIGITS_ONLY.test(value)) return t('recovery_pin.errors.digits_only')
    if (value.length < RECOVERY_PIN_CONFIG.MIN_DIGITS) {
      return t('recovery_pin.errors.min_digits', { count: RECOVERY_PIN_CONFIG.MIN_DIGITS })
    }
    return null
  }, [t])

  const parseOptionalEpoch = useCallback((value: string, label: string): number | undefined => {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(t('recovery_pin.errors.invalid_epoch', { label }))
    }
    return parsed
  }, [t])

  const archiveCurrentChannel = useCallback(async () => {
    if (!channel?.id || !channel.type || !mlsManager?.archiveCurrentEpoch || !isE2eeChannel) return
    await mlsManager.archiveCurrentEpoch(channel.type, channel.id)
  }, [channel?.id, channel?.type, isE2eeChannel, mlsManager])

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setLocalError(null)
    try {
      await action()
    } catch (err) {
      const message = toErrorMessage(err)
      setLocalError(message)
      toast.error(message)
    }
  }, [])

  const setupError = validatePin(pin) || (confirmPin && pin !== confirmPin ? t('recovery_pin.errors.pin_mismatch') : null)
  const unlockError = validatePin(pin)
  const changeError = validatePin(oldPin) || validatePin(newPin)
  const working = recovery.status === 'working'
  const restoredCount = restored?.filter((item) => !item.gap).length ?? 0
  const gapCount = restored?.filter((item) => item.gap).length ?? 0

  const tabs = useMemo(() => ([
    { id: 'unlock' as const, label: t('recovery_pin.tabs.unlock'), icon: LockOpen },
    { id: 'setup' as const, label: t('recovery_pin.tabs.setup'), icon: ShieldPlus },
    { id: 'change' as const, label: t('recovery_pin.tabs.change'), icon: RotateCcw },
    { id: 'restore' as const, label: t('recovery_pin.tabs.restore'), icon: RefreshCw },
  ]), [t])

  const handleSetup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (setupError || working) return
    runAction(async () => {
      await recovery.setupRecoveryPin(pin)
      try {
        await archiveCurrentChannel()
      } catch (err) {
        console.warn('[PIN Recovery] Current epoch archive failed', err)
        toast.warning(t('recovery_pin.archive_warning'))
      }
      toast.success(t('recovery_pin.setup_success'))
      setPin('')
      setConfirmPin('')
      if (isGate) {
        onUnlocked?.()
        return
      }
      setMode('restore')
    })
  }

  const handleUnlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (unlockError || !pin || working) return
    runAction(async () => {
      await recovery.unlockRecoveryVault(pin)
      toast.success(t('recovery_pin.unlock_success'))
      setPin('')
      if (isGate) {
        onUnlocked?.()
        return
      }
      setMode('restore')
    })
  }

  const handleChange = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (changeError || !oldPin || !newPin || working) return
    runAction(async () => {
      await recovery.changeRecoveryPin(oldPin, newPin)
      toast.success(t('recovery_pin.change_success'))
      setOldPin('')
      setNewPin('')
      setMode('restore')
    })
  }

  const handleRestore = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!channel?.id || !channel.type || working) return
    runAction(async () => {
      const from = parseOptionalEpoch(fromEpoch, t('recovery_pin.from_epoch'))
      const to = parseOptionalEpoch(toEpoch, t('recovery_pin.to_epoch'))
      const options = from === undefined && to === undefined ? undefined : { fromEpoch: from, toEpoch: to }
      const result = await recovery.restoreHistoricalMessages(channel.type, channel.id!, options)
      setRestored(result)
      const ok = result.filter((item) => !item.gap).length
      const gaps = result.length - ok
      toast.success(t('recovery_pin.restore_success', { count: ok, gaps }))
    })
  }

  const renderBody = () => {
    if (!mlsInitialized) {
      return (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] font-medium text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          {t('recovery_pin.mls_unavailable')}
        </div>
      )
    }

    if (!isGate && !isE2eeChannel) {
      return (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[13px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-300">
          {t('recovery_pin.e2ee_required')}
        </div>
      )
    }

    const activeMode = isGate
      ? recovery.recoveryStatus?.hasVault === false ? 'setup' : 'unlock'
      : mode

    return (
      <>
        {isGate && activeMode === 'unlock' && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200">
            {(recovery.recoveryStatus?.incompleteChannels.length || 0) > 0
              ? t('recovery_pin.gate_description', {
                count: recovery.recoveryStatus?.incompleteChannels.length || 0,
              })
              : t('recovery_pin.gate_generic_description')}
          </div>
        )}

        {isGate && activeMode === 'setup' && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[13px] font-medium text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
            {t('recovery_pin.gate_setup_description')}
          </div>
        )}

        {!isGate && (
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/60">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setMode(id)
                  setLocalError(null)
                }}
                className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-[12px] font-semibold transition-colors ${
                  mode === id
                    ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-950 dark:text-zinc-50'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        )}

        {activeMode === 'unlock' && (
          <form className="space-y-4" onSubmit={handleUnlock}>
            <div className="space-y-1.5">
              <Label htmlFor="recovery-unlock-pin" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                {t('recovery_pin.pin_label')}
              </Label>
              <Input
                id="recovery-unlock-pin"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                placeholder={t('recovery_pin.pin_placeholder')}
                disabled={working}
                className="h-10"
              />
            </div>
            {unlockError && <ErrorText>{unlockError}</ErrorText>}
            <Button type="submit" disabled={!pin || !!unlockError || working} className="w-full">
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isGate ? t('recovery_pin.gate_restore_action') : t('recovery_pin.unlock_action')}
            </Button>
            {isGate && onSkip && (
              <Button type="button" variant="ghost" disabled={working} onClick={onSkip} className="w-full">
                {t('recovery_pin.gate_skip_action')}
              </Button>
            )}
          </form>
        )}

        {activeMode === 'setup' && (
          <form className="space-y-4" onSubmit={handleSetup}>
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] font-medium text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
              {t('recovery_pin.setup_note')}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="recovery-new-pin" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                  {t('recovery_pin.new_pin_label')}
                </Label>
                <Input
                  id="recovery-new-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  placeholder={t('recovery_pin.pin_placeholder')}
                  disabled={working}
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="recovery-confirm-pin" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                  {t('recovery_pin.confirm_pin_label')}
                </Label>
                <Input
                  id="recovery-confirm-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value)}
                  placeholder={t('recovery_pin.confirm_pin_placeholder')}
                  disabled={working}
                  className="h-10"
                />
              </div>
            </div>
            {setupError && <ErrorText>{setupError}</ErrorText>}
            <Button type="submit" disabled={!pin || !confirmPin || !!setupError || working} className="w-full">
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('recovery_pin.setup_action')}
            </Button>
            {isGate && onSkip && (
              <Button type="button" variant="ghost" disabled={working} onClick={onSkip} className="w-full">
                {t('recovery_pin.gate_skip_action')}
              </Button>
            )}
          </form>
        )}

        {!isGate && mode === 'change' && (
          <form className="space-y-4" onSubmit={handleChange}>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="recovery-old-pin" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                  {t('recovery_pin.current_pin_label')}
                </Label>
                <Input
                  id="recovery-old-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  value={oldPin}
                  onChange={(event) => setOldPin(event.target.value)}
                  placeholder={t('recovery_pin.current_pin_placeholder')}
                  disabled={working}
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="recovery-change-pin" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                  {t('recovery_pin.new_pin_label')}
                </Label>
                <Input
                  id="recovery-change-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={newPin}
                  onChange={(event) => setNewPin(event.target.value)}
                  placeholder={t('recovery_pin.pin_placeholder')}
                  disabled={working}
                  className="h-10"
                />
              </div>
            </div>
            {changeError && <ErrorText>{changeError}</ErrorText>}
            <Button type="submit" disabled={!oldPin || !newPin || !!changeError || working} className="w-full">
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('recovery_pin.change_action')}
            </Button>
          </form>
        )}

        {!isGate && mode === 'restore' && (
          <form className="space-y-4" onSubmit={handleRestore}>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="recovery-from-epoch" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                  {t('recovery_pin.from_epoch')}
                </Label>
                <Input
                  id="recovery-from-epoch"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={fromEpoch}
                  onChange={(event) => setFromEpoch(event.target.value)}
                  placeholder={t('recovery_pin.epoch_placeholder')}
                  disabled={working}
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="recovery-to-epoch" className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                  {t('recovery_pin.to_epoch')}
                </Label>
                <Input
                  id="recovery-to-epoch"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={toEpoch}
                  onChange={(event) => setToEpoch(event.target.value)}
                  placeholder={typeof currentEpoch === 'number' && currentEpoch >= 0 ? String(currentEpoch) : t('recovery_pin.epoch_placeholder')}
                  disabled={working}
                  className="h-10"
                />
              </div>
            </div>
            <Button type="submit" disabled={!channel?.id || working} className="w-full">
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('recovery_pin.restore_action')}
            </Button>

            {restored && (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="mb-2 text-[12px] font-semibold text-zinc-600 dark:text-zinc-300">
                  {t('recovery_pin.restore_summary', { count: restoredCount, gaps: gapCount })}
                </div>
                <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                  {restored.slice(0, RECOVERY_PIN_CONFIG.RESTORE_PREVIEW_LIMIT).map((item, index) => (
                    <div
                      key={`${item.epoch}:${item.messageId || index}`}
                      className="rounded-md bg-white px-3 py-2 text-[12px] text-zinc-700 shadow-sm dark:bg-zinc-950/60 dark:text-zinc-200"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                        <span>{t('recovery_pin.epoch_label', { epoch: item.epoch })}</span>
                        {item.messageId && <span className="truncate font-mono">{item.messageId}</span>}
                      </div>
                      {item.gap ? (
                        <span className="text-amber-700 dark:text-amber-300">
                          {t(`recovery_pin.gap_reason.${item.reason || 'unknown'}`)}
                        </span>
                      ) : (
                        <span className="line-clamp-3">{getRestoredText(item.plaintext) || t('recovery_pin.empty_plaintext')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </form>
        )}

        {(localError || recovery.error) && (
          <ErrorText>{localError || recovery.error?.message}</ErrorText>
        )}
      </>
    )
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-[480px] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <DialogTitle className="flex items-center gap-2 text-[16px]">
            <KeyRound className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
            {isGate ? t('recovery_pin.gate_title') : t('recovery_pin.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 p-5">
          {!isGate && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/30">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                  {channel?.data?.name || channel?.id || t('recovery_pin.no_channel')}
                </div>
                <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  {typeof currentEpoch === 'number' && currentEpoch >= 0
                    ? t('recovery_pin.current_epoch', { epoch: currentEpoch })
                    : t('recovery_pin.epoch_unknown')}
                </div>
              </div>
              <div className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold ${
                recovery.hasRecoveryKey
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${recovery.hasRecoveryKey ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                {recovery.hasRecoveryKey ? t('recovery_pin.status_ready') : t('recovery_pin.status_locked')}
              </div>
            </div>
          )}

          {renderBody()}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ErrorText({ children }: { children: string | null | undefined }) {
  if (!children) return null

  return (
    <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] font-medium text-red-600 dark:bg-red-500/10 dark:text-red-300">
      <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}
