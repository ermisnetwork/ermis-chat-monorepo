import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Forward,
  Pin,
  PinOff,
  Pencil,
  Copy,
  Trash2,
  MoreHorizontal,
  MessageSquareQuote,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk'
import {
  useMessageActions,
  useChatClient,
} from '@ermis-network/ermis-chat-react'
import { UhmConfirmDialog } from './UhmConfirmDialog'

/* ----------------------------------------------------------
   UhmMessageActions
   Replaces SDK's MessageActionsBox with a Radix-based
   dropdown aligned with the Uhm brand design.
   ---------------------------------------------------------- */

interface UhmMessageActionsProps {
  message: FormatMessageResponse
  isOwnMessage: boolean
  onReply?: (message: FormatMessageResponse) => void
  onForward?: (message: FormatMessageResponse) => void
  onPinToggle?: (message: FormatMessageResponse, isPinned: boolean) => void
  onEdit?: (message: FormatMessageResponse) => void
  onCopy?: (message: FormatMessageResponse) => void
  onDelete?: (message: FormatMessageResponse) => void
  onDeleteForMe?: (message: FormatMessageResponse) => void
}

export function UhmMessageActions({
  message,
  isOwnMessage,
  onReply: onReplyProp,
  onForward: onForwardProp,
  onPinToggle: onPinToggleProp,
  onEdit: onEditProp,
  onCopy: onCopyProp,
  onDelete: onDeleteProp,
  onDeleteForMe: onDeleteForMeProp,
}: UhmMessageActionsProps) {
  const { t } = useTranslation()
  const { setQuotedMessage, setEditingMessage, setForwardingMessage, activeChannel } =
    useChatClient()
  const actions = useMessageActions(message, isOwnMessage)

  /* --- Confirm dialog state for destructive actions --- */
  const [pendingDelete, setPendingDelete] = useState<{
    type: 'for_me' | 'for_everyone'
    execute: () => Promise<void>
  } | null>(null)

  /* --- Default handlers --- */
  const handleReply = useCallback(() => {
    if (onReplyProp) onReplyProp(message)
    else setQuotedMessage(message)
  }, [message, onReplyProp, setQuotedMessage])

  const handleForward = useCallback(() => {
    if (onForwardProp) onForwardProp(message)
    else setForwardingMessage(message)
  }, [message, onForwardProp, setForwardingMessage])

  const handlePinToggle = useCallback(async () => {
    if (onPinToggleProp) {
      onPinToggleProp(message, actions.isPinned)
      return
    }
    if (!activeChannel) return
    try {
      if (actions.isPinned) await activeChannel.unpinMessage(message.id!)
      else await activeChannel.pinMessage(message.id!)
    } catch (err) {
      console.error('Failed to toggle pin', err)
    }
  }, [message, actions.isPinned, onPinToggleProp, activeChannel])

  const handleEdit = useCallback(() => {
    if (onEditProp) onEditProp(message)
    else setEditingMessage(message)
  }, [message, onEditProp, setEditingMessage])

  const handleCopy = useCallback(async () => {
    if (onCopyProp) {
      onCopyProp(message)
      return
    }
    if (message.text) {
      try {
        await navigator.clipboard.writeText(message.text)
        toast.success(t('message_actions.copy_success', 'Copied to clipboard'))
      } catch (err) {
        console.error('Failed to copy text:', err)
      }
    }
  }, [message, onCopyProp, t])

  /* --- Actual delete logic (called after confirm) --- */
  const executeDeleteForEveryone = useCallback(async () => {
    if (onDeleteProp) {
      onDeleteProp(message)
      return
    }
    if (!activeChannel) return
    try {
      await activeChannel.deleteMessage(message.id!)
    } catch (err) {
      console.error('Failed to delete message', err)
    }
  }, [message, onDeleteProp, activeChannel])

  const executeDeleteForMe = useCallback(async () => {
    if (onDeleteForMeProp) {
      onDeleteForMeProp(message)
      return
    }
    if (!activeChannel) return
    try {
      await activeChannel.deleteMessageForMe(message.id!)
    } catch (err) {
      console.error('Failed to delete message for me', err)
    }
  }, [message, onDeleteForMeProp, activeChannel])

  /* --- Handlers that open the confirm dialog --- */
  const handleDeleteForEveryone = useCallback(() => {
    setPendingDelete({ type: 'for_everyone', execute: executeDeleteForEveryone })
  }, [executeDeleteForEveryone])

  const handleDeleteForMe = useCallback(() => {
    setPendingDelete({ type: 'for_me', execute: executeDeleteForMe })
  }, [executeDeleteForMe])

  const handleConfirmDelete = useCallback(async () => {
    if (pendingDelete) {
      await pendingDelete.execute()
      setPendingDelete(null)
    }
  }, [pendingDelete])

  const handleCancelDelete = useCallback(() => {
    setPendingDelete(null)
  }, [])

  /* --- Check if we have any dropdown actions --- */
  const hasDropdownActions =
    actions.canPin || actions.canEdit || actions.canCopy || actions.canDelete || actions.canDeleteForMe

  return (
    <>
      <div
        className={`ermis-message-list__actions`}
      >
        {/* Reply */}
        {actions.canReply && (
          <button
            type="button"
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-500 dark:text-zinc-400 hover:text-primary hover:bg-primary/10 hover:shadow-sm dark:hover:text-purple-400 dark:hover:bg-purple-500/15 transition-all duration-200 ease-out active:scale-90 disabled:opacity-30 disabled:pointer-events-none"
            onClick={handleReply}
            title={t('message_actions.reply', 'Reply')}
            disabled={!actions.hasCapReply}
          >
            <MessageSquareQuote className="w-[15px] h-[15px]" />
          </button>
        )}

        {/* Forward */}
        {actions.canForward && (
          <button
            type="button"
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-500 dark:text-zinc-400 hover:text-primary hover:bg-primary/10 hover:shadow-sm dark:hover:text-purple-400 dark:hover:bg-purple-500/15 transition-all duration-200 ease-out active:scale-90 disabled:opacity-30 disabled:pointer-events-none"
            onClick={handleForward}
            title={t('message_actions.forward', 'Forward')}
            disabled={!actions.hasCapQuote}
          >
            <Forward className="w-[15px] h-[15px]" />
          </button>
        )}

        {/* More Actions Dropdown */}
        {hasDropdownActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-500 dark:text-zinc-400 hover:text-primary hover:bg-primary/10 hover:shadow-sm dark:hover:text-purple-400 dark:hover:bg-purple-500/15 transition-all duration-200 ease-out active:scale-90"
                title={t('message_actions.more', 'More')}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="w-[15px] h-[15px]" />
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align={isOwnMessage ? 'end' : 'start'}
              sideOffset={6}
              className="min-w-[180px] p-1"
            >
              {/* Pin */}
              {actions.canPin && (
                <DropdownMenuItem
                  className="flex items-center gap-2.5 px-2.5 py-2 text-[13px] rounded-md cursor-pointer transition-colors"
                  onClick={handlePinToggle}
                  disabled={!actions.hasCapPin}
                >
                  {actions.isPinned ? (
                    <PinOff className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                  ) : (
                    <Pin className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                  )}
                  <span>
                    {actions.isPinned
                      ? t('message_actions.unpin', 'Unpin')
                      : t('message_actions.pin', 'Pin')}
                  </span>
                </DropdownMenuItem>
              )}

              {/* Edit */}
              {actions.canEdit && (
                <DropdownMenuItem
                  className="flex items-center gap-2.5 px-2.5 py-2 text-[13px] rounded-md cursor-pointer transition-colors"
                  onClick={handleEdit}
                  disabled={!actions.hasCapEdit}
                >
                  <Pencil className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                  <span>{t('message_actions.edit', 'Edit')}</span>
                </DropdownMenuItem>
              )}

              {/* Copy */}
              {actions.canCopy && (
                <DropdownMenuItem
                  className="flex items-center gap-2.5 px-2.5 py-2 text-[13px] rounded-md cursor-pointer transition-colors"
                  onClick={handleCopy}
                >
                  <Copy className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                  <span>{t('message_actions.copy', 'Copy')}</span>
                </DropdownMenuItem>
              )}

              {/* Separator before danger */}
              {(actions.canPin || actions.canEdit || actions.canCopy) && (actions.canDelete || actions.canDeleteForMe) && (
                <DropdownMenuSeparator className="my-1" />
              )}

              {/* Delete for me */}
              {actions.canDeleteForMe && (
                <DropdownMenuItem
                  className="flex items-center gap-2.5 px-2.5 py-2 text-[13px] rounded-md cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400 focus:bg-red-50 dark:focus:bg-red-950/30 transition-colors"
                  onClick={handleDeleteForMe}
                  disabled={!actions.hasCapDeleteForMe}
                >
                  <Trash2 className="w-4 h-4" />
                  <span>{t('message_actions.delete_for_me', 'Delete for me')}</span>
                </DropdownMenuItem>
              )}

              {/* Delete for everyone */}
              {actions.canDelete && (
                <DropdownMenuItem
                  className="flex items-center gap-2.5 px-2.5 py-2 text-[13px] rounded-md cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400 focus:bg-red-50 dark:focus:bg-red-950/30 transition-colors"
                  onClick={handleDeleteForEveryone}
                  disabled={!actions.hasCapDelete}
                >
                  <Trash2 className="w-4 h-4" />
                  <span>{t('message_actions.delete_for_everyone', 'Delete for everyone')}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {pendingDelete && (
        <UhmConfirmDialog
          isOpen={true}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
          title={
            pendingDelete.type === 'for_everyone'
              ? t('message_actions.confirm_delete_everyone_title', 'Delete for everyone')
              : t('message_actions.confirm_delete_for_me_title', 'Delete for me')
          }
          message={
            pendingDelete.type === 'for_everyone'
              ? t('message_actions.confirm_delete_everyone_message', 'This message will be permanently deleted for all participants. This action cannot be undone.')
              : t('message_actions.confirm_delete_for_me_message', 'This message will be removed from your view. Other participants can still see it.')
          }
          confirmLabel={t('message_actions.confirm_delete_yes', 'Delete')}
          cancelLabel={t('actions.confirm_cancel', 'Cancel')}
          isDanger
        />
      )}
    </>
  )
}
