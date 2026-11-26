import { useTranslation } from 'react-i18next';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { secureSessionScope } from './secureSessionNotice';
import { useSecureSessionRecovery } from './useSecureSessionRecovery';

export function UhmChannelRecoveryIndicator({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const scope = secureSessionScope(channel);
  const blocked = useSecureSessionRecovery(channel.getClient(), channel.cid, scope === channel.cid ? scope : '', true);
  if (!blocked) return null;
  return (
    <span role="img" aria-label={t('e2ee.recovery_icon')}
      className="absolute bottom-0 left-0 z-[1] grid h-3.5 w-3.5 place-items-center rounded-full border border-white bg-red-600 text-[10px] font-bold leading-none text-white pointer-events-none dark:border-zinc-900"
      data-channel-recovery-indicator>
      <span aria-hidden="true">!</span>
    </span>
  );
}
