import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, LockKeyhole, RefreshCw } from 'lucide-react';
import type { Channel, ErmisChat } from '@ermis-network/ermis-chat-sdk';
import { recordMlsRepairDiagnostic } from '@/utils/mlsRepairDiagnostics';
import {
  SECURE_SESSION_WORKING_LIMIT_MS,
  secureSessionPresentation,
  secureSessionScope,
  updateSecureSessionNotice,
  type SecureSessionEvent,
  type SecureSessionNotice,
} from './secureSessionNotice';

export function SecureSessionBanner({ client, channel }: { client: ErmisChat | null; channel: Channel | null }) {
  const { t } = useTranslation();
  const scopeCid = channel ? secureSessionScope(channel) : '';
  const [notice, setNotice] = useState<SecureSessionNotice | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(Date.now);
  const session = useRef(0);
  const retryInFlight = useRef(false);
  const notices = useRef(new Map<string, SecureSessionNotice>());
  const noticeOwner = useRef({ client, userID: client?.userID });

  useEffect(() => {
    const version = ++session.current;
    retryInFlight.current = false;
    if (noticeOwner.current.client !== client || noticeOwner.current.userID !== client?.userID) {
      notices.current.clear();
      noticeOwner.current = { client, userID: client?.userID };
    }
    setNotice(notices.current.get(scopeCid) || null);
    setNow(Date.now());
    setRetrying(false);
    if (!client) return;
    const handle = (event: SecureSessionEvent) => {
      if (session.current !== version || !event.cid) return;
      const checkedAt = Date.now();
      const next = updateSecureSessionNotice(notices.current.get(event.cid) || null, event, event.cid, checkedAt);
      if (next) notices.current.set(event.cid, next);
      else notices.current.delete(event.cid);
      if (event.cid === scopeCid) {
        setNow(checkedAt);
        setNotice(next);
      }
    };
    const repair = client.on('e2ee.group_info_repair_state', handle);
    const generation = client.on('e2ee.mls_generation_recovery_state', handle);
    const ready = client.on('e2ee.channel_ready', (event) => handle({ cid: event.cid, status: 'recovered' }));
    return () => {
      ++session.current;
      repair.unsubscribe();
      generation.unsubscribe();
      ready.unsubscribe();
    };
  }, [client, client?.userID, scopeCid]);

  useEffect(() => {
    if (!notice || !['refreshing', 'preparing'].includes(notice.message)) return;
    const remaining = notice.startedAt + SECURE_SESSION_WORKING_LIMIT_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const retry = async () => {
    const manager = client?.encryptionManager;
    if (!manager?.initialized || !scopeCid || retryInFlight.current) return;
    const separator = scopeCid.indexOf(':');
    if (separator < 1) return;
    const channelType = scopeCid.slice(0, separator);
    const channelId = scopeCid.slice(separator + 1);
    const version = session.current;
    const publish = (event: SecureSessionEvent) => {
      if (session.current !== version) return;
      const checkedAt = Date.now();
      const next = updateSecureSessionNotice(notices.current.get(scopeCid) || null, { ...event, cid: scopeCid }, scopeCid, checkedAt);
      if (next) notices.current.set(scopeCid, next);
      else notices.current.delete(scopeCid);
      setNow(checkedAt);
      setNotice(next);
    };
    retryInFlight.current = true;
    recordMlsRepairDiagnostic('manual_repair_start', { cid: scopeCid });
    setRetrying(true);
    const startedAt = Date.now();
    setNow(startedAt);
    const checking: SecureSessionNotice = { cid: scopeCid, source: 'manual', message: 'refreshing', startedAt };
    notices.current.set(scopeCid, checking);
    setNotice(checking);
    try {
      await manager.reconcileGroupInfoRefresh(scopeCid);
      if (session.current !== version) return;
      notices.current.set(scopeCid, checking);
      setNotice(checking);
      // Explicit user action: generation recovery still requires server authorization.
      const recovery = await manager.recoverMlsGeneration(channelType, channelId, scopeCid);
      recordMlsRepairDiagnostic('manual_generation_result', { cid: scopeCid, status: recovery.status, reason: recovery.reason });
      if (session.current !== version) return;
      if (!['recovered', 'history_incomplete'].includes(recovery.status)) {
        publish({ status: recovery.status, reason: recovery.reason });
        return;
      }
      const result = await manager.ensureChannelReady(channelType, channelId, scopeCid, { source: 'manual_retry' });
      recordMlsRepairDiagnostic('manual_readiness_result', { cid: scopeCid, status: result.status });
      if (session.current !== version) return;
      publish({ status: result.status === 'ready' ? recovery.status : 'retryable_infrastructure_failure' });
    } catch {
      if (notices.current.get(scopeCid)?.message !== 'waiting_member') {
        publish({ status: 'retryable_infrastructure_failure' });
      }
    } finally {
      if (session.current === version) {
        retryInFlight.current = false;
        setRetrying(false);
      }
    }
  };

  if (!notice || notice.cid !== scopeCid) return null;
  const view = secureSessionPresentation(notice, now);
  const Icon = view.working ? RefreshCw : view.message === 'history' ? Info : LockKeyhole;
  return (
    <div className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${view.working
      ? 'border-sky-500/20 bg-sky-500/10 text-sky-800 dark:text-sky-300'
      : 'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300'}`}
      role="status" aria-live="polite" aria-atomic="true">
      <Icon className={`h-4 w-4 shrink-0 ${view.working ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">{t(`e2ee.secure_session_${view.message}`)}</span>
      {view.canRetry && (
        <button type="button" onClick={() => void retry()} disabled={retrying || !client?.encryptionManager?.initialized}
          className="shrink-0 rounded-md bg-amber-500/15 px-3 py-1 text-xs font-semibold hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-50">
          {t('app.retry', 'Try again')}
        </button>
      )}
    </div>
  );
}
