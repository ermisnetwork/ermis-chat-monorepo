import { useCallback } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

interface UhmConfirmDialogProps {
  isOpen: boolean
  onConfirm: () => void
  onCancel: () => void
  title: string
  /** Supports ReactNode for rich content (e.g. bold channel names) */
  message: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  isDanger?: boolean
}

export function UhmConfirmDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  message,
  confirmLabel,
  cancelLabel,
  isDanger = true,
}: UhmConfirmDialogProps) {
  const handleConfirm = useCallback(() => {
    onConfirm()
  }, [onConfirm])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent
        className="sm:max-w-[400px] p-0 gap-0 overflow-hidden"
        hideCloseButton
        onPointerDownOutside={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Icon + Text */}
        <div className="px-6 pt-6 pb-4">
          <DialogHeader className="flex-row items-start gap-3 space-y-0">
            <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
              isDanger
                ? 'bg-red-100 dark:bg-red-950/50'
                : 'bg-amber-100 dark:bg-amber-950/50'
            }`}>
              <AlertTriangle className={`w-5 h-5 ${
                isDanger
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`} />
            </div>
            <div className="flex flex-col gap-1.5 text-left">
              <DialogTitle className="text-[15px] font-semibold leading-snug">
                {title}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {message}
                </div>
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>

        {/* Action buttons */}
        <DialogFooter className="px-6 py-4 bg-zinc-50 dark:bg-[#211f30]/50 border-t border-zinc-100 dark:border-zinc-800/50 flex-row justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-8 px-4 text-[13px] font-medium rounded-md"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={isDanger ? 'destructive' : 'default'}
            size="sm"
            onClick={handleConfirm}
            className={`h-8 px-4 text-[13px] font-medium rounded-md ${
              isDanger
                ? 'bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 text-white'
                : ''
            }`}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
