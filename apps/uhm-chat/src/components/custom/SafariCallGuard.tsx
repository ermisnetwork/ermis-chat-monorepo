import { useEffect } from 'react'
import { useCallContext } from '@ermis-network/ermis-chat-react'
import { CallStatus } from '@ermis-network/ermis-chat-sdk'
import { toast } from 'sonner'
import i18n from '../../i18n'

/**
 * SafariCallGuard replaces the CallUI on Safari.
 * 
 * IMPORTANT: We do NOT call rejectCall() here because the same user
 * may be logged in on Chrome simultaneously. Rejecting on Safari would
 * send a "reject" signal to the caller, preventing Chrome from handling
 * the call. Instead, we silently ignore it and show a local toast.
 * The call will be handled by Chrome or eventually time out.
 */
export function SafariCallGuard() {
  const { callStatus, isIncoming, callerInfo } = useCallContext()

  useEffect(() => {
    // Show a local-only toast when an incoming call is detected
    if (isIncoming && callStatus === CallStatus.RINGING) {
      const callerName = callerInfo?.name || callerInfo?.id || ''

      toast.info(
        i18n.t('safari_call.incoming_rejected', {
          name: callerName,
          defaultValue: `${callerName} is calling you. Audio/Video calls are not supported on Safari. Please use Chrome or Firefox.`
        }),
        { duration: 6000 }
      )
    }
  }, [callStatus, isIncoming])

  // Render nothing — no call UI on Safari
  return null
}
