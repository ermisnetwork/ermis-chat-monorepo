/** Accept one keyboard emoji without splitting joined families, modifiers, flags or keycaps. */
export function isTopicEmoji(value: string): boolean {
  const emoji = value.trim();
  if (!emoji) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(emoji)];
  return graphemes.length === 1 &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(emoji);
}
