import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Pin,
  PinOff,
  Ban,
  ShieldCheck,
  Pencil,
  Lock,
  Unlock,
  Plus,
  Trash2,
  LogOut,
  MoreHorizontal,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActionConfirm, needsConfirmation } from './useActionConfirm'
import type { Channel } from '@ermis-network/ermis-chat-sdk'

/* ----------------------------------------------------------
   Icon map: action.id → lucide icon component
   ---------------------------------------------------------- */
const ACTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  pin: Pin,
  unpin: PinOff,
  block: Ban,
  unblock: ShieldCheck,
  edit_topic: Pencil,
  close: Lock,
  reopen: Unlock,
  create_topic: Plus,
  delete: Trash2,
  leave: LogOut,
}

/* ----------------------------------------------------------
   Types from SDK (kept minimal to avoid deep import)
   ---------------------------------------------------------- */
interface ChannelAction {
  id: string
  label: string
  icon?: React.ReactNode
  onClick: (channel: Channel, e: React.MouseEvent) => void
  isDanger?: boolean
}

interface UhmChannelActionsProps {
  channel: Channel
  actions: ChannelAction[]
  onClose: () => void
}

/* ----------------------------------------------------------
   UhmChannelActions — Custom channel actions dropdown
   Uses Radix DropdownMenu + lucide-react icons + TailwindCSS
   ---------------------------------------------------------- */
export function UhmChannelActions({ channel, actions, onClose }: UhmChannelActionsProps) {
  const { t } = useTranslation()
  const { requestConfirm, confirmDialog } = useActionConfirm()

  const handleActionClick = useCallback(
    (action: ChannelAction, e: React.MouseEvent) => {
      e.stopPropagation()

      // Check if this action needs confirmation
      if (needsConfirmation(action.id)) {
        requestConfirm(action.id, channel, () => {
          action.onClick(channel, new MouseEvent('click') as unknown as React.MouseEvent)
        })
        return
      }

      // Execute immediately for non-destructive actions
      action.onClick(channel, e)
    },
    [channel, requestConfirm],
  )

  if (!actions || actions.length === 0) return null

  // Split actions into normal + danger groups
  const normalActions = actions.filter((a) => !a.isDanger)
  const dangerActions = actions.filter((a) => a.isDanger)

  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (!open) onClose() }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-center w-6 h-6 rounded-md bg-white/80 dark:bg-[#211f30]/80 backdrop-blur-sm text-zinc-400 dark:text-zinc-500 border border-zinc-200/60 dark:border-zinc-700/60 cursor-pointer transition-all duration-150 hover:text-zinc-700 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-600 hover:shadow-sm active:scale-95"
            title={t('actions.more_actions', 'More actions')}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-[180px] p-1"
        >
          {/* Normal actions */}
          {normalActions.map((action) => {
            const IconComponent = ACTION_ICONS[action.id]
            return (
              <DropdownMenuItem
                key={action.id}
                className="flex items-center gap-2.5 px-2.5 py-2 text-[13px] rounded-md cursor-pointer transition-colors"
                onClick={(e) => handleActionClick(action, e as unknown as React.MouseEvent)}
              >
                {IconComponent ? (
                  <IconComponent className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                ) : (
                  action.icon
                )}
                <span>{action.label}</span>
              </DropdownMenuItem>
            )
          })}

          {/* Separator before danger actions */}
          {normalActions.length > 0 && dangerActions.length > 0 && (
            <DropdownMenuSeparator className="my-1" />
          )}

          {/* Danger actions */}
          {dangerActions.map((action) => {
            const IconComponent = ACTION_ICONS[action.id]
            return (
              <DropdownMenuItem
                key={action.id}
                className="flex items-center gap-2.5 px-2.5 py-2 text-[13px] rounded-md cursor-pointer text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400 focus:bg-red-50 dark:focus:bg-red-950/30 transition-colors"
                onClick={(e) => handleActionClick(action, e as unknown as React.MouseEvent)}
              >
                {IconComponent ? (
                  <IconComponent className="w-4 h-4" />
                ) : (
                  action.icon
                )}
                <span>{action.label}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Confirm dialog — rendered by useActionConfirm hook */}
      {confirmDialog}
    </>
  )
}
