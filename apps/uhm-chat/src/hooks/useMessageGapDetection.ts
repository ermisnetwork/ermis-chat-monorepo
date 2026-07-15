import { useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';

type GapDetectionResult = {
  hasGap: boolean;
  gapAfterIndex?: number;
  gapSeqRange?: [number, number];
};

/**
 * Hook to detect message gaps during scroll/pagination.
 * Checks if gaps between adjacent messages' msg_seq values are real
 * (need backfill) or fake (hidden/truncated).
 * @see intergration-guide.md Section 6.3
 */
export function useMessageGapDetection(channel: Channel | null): GapDetectionResult {
  return useMemo(() => {
    if (!channel?.state) return { hasGap: false };

    const messages = channel.state.messages;
    for (let i = 0; i < messages.length - 1; i++) {
      const seqA = (messages[i] as any).msg_seq as number | undefined;
      const seqB = (messages[i + 1] as any).msg_seq as number | undefined;

      if (seqA && seqB && seqB - seqA > 1) {
        if (!channel.state.isFakeMessageGap(seqA, seqB)) {
          return {
            hasGap: true,
            gapAfterIndex: i,
            gapSeqRange: [seqA + 1, seqB - 1],
          };
        }
      }
    }

    return { hasGap: false };
  }, [channel?.state?.messages]);
}
