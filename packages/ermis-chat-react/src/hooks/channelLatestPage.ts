/** A sidebar preview is never proof that the channel's latest page was queried. */
const completed = new WeakSet<object>();
const inFlight = new WeakMap<object, Promise<unknown>>();

export const hasLatestPage = (channel: object) => completed.has(channel);

export function markLatestPage(channel: object): void {
  completed.add(channel);
}

/** Object ownership keeps simultaneous mounts coalesced without leaking across sessions. */
export function queryLatestPage<T>(channel: {
  query: (options: { messages_seq: { limit: number } }, messageSet?: 'current', showHistoryProgress?: boolean) => Promise<T>;
}): Promise<T> {
  const pending = inFlight.get(channel);
  if (pending) return pending as Promise<T>;
  const request = Promise.resolve().then(() => channel.query({ messages_seq: { limit: 25 } }, 'current', true)).then(result => {
    completed.add(channel);
    return result;
  }).finally(() => {
    if (inFlight.get(channel) === request) inFlight.delete(channel);
  });
  inFlight.set(channel, request);
  return request;
}
