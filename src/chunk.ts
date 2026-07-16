export function chunkText(text: string, limit = 4000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
    const splitAt = candidates.find((index) => index >= Math.floor(limit * 0.6)) ?? limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);

  if (chunks.length === 1) return chunks;
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}
