import { useState, useCallback } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { UhmConfirmDialog } from './UhmConfirmDialog'
import type { Channel } from '@ermis-network/ermis-chat-sdk'

/* ----------------------------------------------------------
   Confirm configuration for each destructive action ID
   ---------------------------------------------------------- */
const CONFIRM_ACTIONS: Record<string, { titleKey: string; messageKey: string }> = {
  delete: {
    titleKey: 'actions.confirm_delete_title',
    messageKey: 'actions.confirm_delete_message',
  },
  leave: {
    titleKey: 'actions.confirm_leave_title',
    messageKey: 'actions.confirm_leave_message',
  },
  block: {
    titleKey: 'actions.confirm_block_title',
    messageKey: 'actions.confirm_block_message',
  },
  unblock: {
    titleKey: 'actions.confirm_unblock_title',
    messageKey: 'actions.confirm_unblock_message',
  },
  close: {
    titleKey: 'actions.confirm_close_topic_title',
    messageKey: 'actions.confirm_close_topic_message',
  },
}

/* ----------------------------------------------------------
   Utility: get the display name from a channel
   ---------------------------------------------------------- */
export function getChannelDisplayName(channel: Channel): string {
  return (channel.data?.name as string) || channel.cid
}

/* ----------------------------------------------------------
   Utility: check if an action ID requires confirmation
   ---------------------------------------------------------- */
export function needsConfirmation(actionId: string): boolean {
  return actionId in CONFIRM_ACTIONS
}

/* ----------------------------------------------------------
   useActionConfirm — reusable hook for confirm dialogs
   Manages pending action state and renders UhmConfirmDialog.
   Can be used from UhmChannelActions, ChannelInfo, or anywhere.
   ---------------------------------------------------------- */
export function useActionConfirm() {
  const { t } = useTranslation()

  const [pendingAction, setPendingAction] = useState<{
    actionId: string
    channel: Channel
    onExecute: () => void
  } | null>(null)

  /** Request confirmation before executing an action */
  const requestConfirm = useCallback(
    (actionId: string, channel: Channel, onExecute: () => void) => {
      setPendingAction({ actionId, channel, onExecute })
    },
    [],
  )

  /** Cancel the pending confirmation */
  const cancelConfirm = useCallback(() => {
    setPendingAction(null)
  }, [])

  /** Execute the pending action and close dialog */
  const executeConfirm = useCallback(() => {
    if (pendingAction) {
      pendingAction.onExecute()
      setPendingAction(null)
    }
  }, [pendingAction])

  /** Render the confirm dialog — call this in your JSX */
  const confirmDialog = (() => {
    if (!pendingAction) return null

    const config = CONFIRM_ACTIONS[pendingAction.actionId]
    if (!config) return null

    const name = getChannelDisplayName(pendingAction.channel)
    const isDanger = pendingAction.actionId !== 'unblock'

    return (
      <UhmConfirmDialog
        isOpen={true}
        onConfirm={executeConfirm}
        onCancel={cancelConfirm}
        title={t(config.titleKey)}
        message={
          <Trans
            i18nKey={config.messageKey}
            values={{ name }}
            components={{ bold: <span className="font-semibold text-zinc-900 dark:text-zinc-100" /> }}
          />
        }
        confirmLabel={t('actions.confirm_yes', 'Confirm')}
        cancelLabel={t('actions.confirm_cancel', 'Cancel')}
        isDanger={isDanger}
      />
    )
  })()

  return {
    /** Whether a confirm dialog is currently open */
    isConfirming: pendingAction !== null,
    /** Request a confirm dialog for a destructive action */
    requestConfirm,
    /** Cancel the pending confirmation */
    cancelConfirm,
    /** The rendered confirm dialog element — include in your JSX return */
    confirmDialog,
    /** Check if an action ID requires confirmation */
    needsConfirmation,
  }
}
