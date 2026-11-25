import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EncryptionManager, FormatMessageResponse, MessageDecryptionReason } from '@ermis-network/ermis-chat-sdk';
import { useChatCore } from '@ermis-network/ermis-chat-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatMessageInfoTime, isUnresolvedE2eeMessage } from './messageInfo';

interface UhmMessageInfoDialogProps {
  message: FormatMessageResponse;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}

export function UhmMessageInfoDialog({ message, onClose, onCloseAutoFocus }: UhmMessageInfoDialogProps) {
  const { t, i18n } = useTranslation();
  const { client, activeChannel } = useChatCore();
  const cid = message.cid || activeChannel?.cid;
  const manager: EncryptionManager | undefined = client?.encryptionManager;
  const unresolved = isUnresolvedE2eeMessage(message);
  const [diagnosis, setDiagnosis] = useState<{ message: FormatMessageResponse; reason: MessageDecryptionReason }>();

  useEffect(() => {
    if (!unresolved || !manager || !cid) return;
    let active = true;
    const apply = (reason: MessageDecryptionReason) => {
      if (active) setDiagnosis({ message, reason });
    };
    void manager.diagnoseMessageDecryption(cid, message).then(apply, () => apply('encryption_unavailable'));
    return () => { active = false; };
  }, [cid, manager, message, unresolved]);

  const reason = diagnosis?.message === message ? diagnosis.reason : undefined;
  const unavailable = t('message_info.time_unavailable');
  const locale = i18n.resolvedLanguage || i18n.language;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
        className="w-[calc(100%-2rem)] max-w-sm rounded-xl"
      >
        <DialogHeader>
          <DialogTitle>{t('message_info.title')}</DialogTitle>
        </DialogHeader>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-zinc-500 dark:text-zinc-400">{t('message_info.created_at')}</dt>
            <dd>{formatMessageInfoTime(message.created_at, locale) ?? unavailable}</dd>
          </div>
          <div>
            <dt className="text-zinc-500 dark:text-zinc-400">{t('message_info.updated_at')}</dt>
            <dd>{formatMessageInfoTime(message.updated_at, locale) ?? unavailable}</dd>
          </div>
          {unresolved && (
            <div>
              <dt className="text-zinc-500 dark:text-zinc-400">{t('message_info.decryption')}</dt>
              <dd aria-live="polite">
                {t(`message_info.reason.${reason ?? (manager && cid ? 'reading' : 'encryption_unavailable')}`)}
              </dd>
            </div>
          )}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
