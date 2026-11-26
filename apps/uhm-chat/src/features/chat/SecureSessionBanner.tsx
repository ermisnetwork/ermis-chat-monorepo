import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, LockKeyhole, RefreshCw } from 'lucide-react';
import type { ErmisChat } from '@ermis-network/ermis-chat-sdk';
import { recordMlsRepairDiagnostic } from '@/utils/mlsRepairDiagnostics';
import { SECURE_SESSION_WORKING_LIMIT_MS, secureSessionPresentation } from './secureSessionNotice';
import { useSecureSessionRecovery } from './useSecureSessionRecovery';

function subscribeConnection(changed: () => void) {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

export function SecureSessionBanner({ client, channelCid, scopeCid, sendReady, canRecover }: {
  client: ErmisChat;
  channelCid: string;
  scopeCid: string;
  sendReady: boolean;
  canRecover: boolean;
}) {
  const { t, i18n } = useTranslation();
  const notice = useSecureSessionRecovery(client, channelCid, scopeCid);
  const online = useSyncExternalStore(subscribeConnection, () => navigator.onLine, () => true);
  const [now, setNow] = useState(Date.now);
  const [showSuccess, setShowSuccess] = useState(false);
  const sawRecovery = useRef(false);

  useEffect(() => {
    if (notice && !sendReady) sawRecovery.current = true;
  }, [notice, sendReady]);

  useEffect(() => {
    if (!sendReady) {
      setShowSuccess(false);
      return;
    }
    if (!sawRecovery.current) return;
    sawRecovery.current = false;
    setShowSuccess(true);
    const timeout = window.setTimeout(() => setShowSuccess(false), 3000);
    return () => window.clearTimeout(timeout);
  }, [sendReady]);

  useEffect(() => {
    if (!notice || sendReady) return;
    const current = Date.now();
    setNow(current);
    const workEndsAt = (notice.startedAt ?? -Infinity) + SECURE_SESSION_WORKING_LIMIT_MS;
    const deadlines = new Set([workEndsAt, Date.parse(notice.retryAt ?? '')]);
    const timers = [...deadlines].filter(deadline => Number.isFinite(deadline) && deadline > current)
      .map(deadline => window.setTimeout(() => setNow(Date.now()), Math.min(deadline - current, 2 ** 31 - 1)));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [notice, sendReady]);

  const view = sendReady
    ? showSuccess ? { message: 'restored', working: false, action: undefined, nextCheck: undefined } : undefined
    : notice ? secureSessionPresentation(notice, now, online) : undefined;
  if (!view) return null;
  const Icon = view.working ? RefreshCw : view.message === 'restored' ? Check : LockKeyhole;
  const action = canRecover ? view.action : view.message === 'restored' ? undefined : 'help';

  const retry = () => {
    const manager = client.encryptionManager;
    if (!manager?.initialized || manager.userId !== client.userID) return;
    recordMlsRepairDiagnostic('manual_repair_start', { cid: scopeCid });
    void manager.retryMlsChannelRecovery(scopeCid).catch(() => {
      // The SDK publishes a typed outcome for the current owner.
    });
  };

  return (
    <div className={`flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm ${view.working
      ? 'border-sky-500/20 bg-sky-500/10 text-sky-800 dark:text-sky-300'
      : view.message === 'restored' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
      : 'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300'}`}
      data-secure-session={view.message}>
      <Icon className={`h-4 w-4 shrink-0 ${view.working ? 'animate-spin' : ''}`} aria-hidden="true" />
      <div className="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
        <span>{t(`e2ee.recovery_${view.message}`)}</span>
        {view.nextCheck && <span className="ms-1">{t('e2ee.recovery_next_check', {
          time: new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }).format(view.nextCheck),
        })}</span>}
      </div>
      {action === 'help' ? (
        <details className="basis-full">
          <summary className="w-fit cursor-pointer font-semibold">{t('e2ee.recovery_help')}</summary>
          <p className="mt-1">{t(canRecover ? 'e2ee.recovery_contact' : 'e2ee.recovery_read_only')}</p>
        </details>
      ) : action && (
        <button type="button" onClick={retry}
          className="shrink-0 rounded-md bg-amber-500/15 px-3 py-1 font-semibold hover:bg-amber-500/25">
          {t(`e2ee.recovery_action_${action}`)}
        </button>
      )}
    </div>
  );
}
