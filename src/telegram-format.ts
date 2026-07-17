function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function renderToken(token: string): string {
  if (token.startsWith("```") && token.endsWith("```")) {
    const body = token.slice(3, -3).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    return `<pre>${escapeHtml(body)}</pre>`;
  }
  if (token.startsWith("`") && token.endsWith("`")) {
    return `<code>${escapeHtml(token.slice(1, -1))}</code>`;
  }
  if (token.startsWith("**") && token.endsWith("**")) {
    return `<b>${escapeHtml(token.slice(2, -2))}</b>`;
  }
  const link = token.match(/^\[([^\]\r\n]+)]\(([^\s)]+)\)$/);
  if (link) {
    const href = safeLink(link[2]!);
    if (href) return `<a href="${escapeHtml(href)}">${escapeHtml(link[1]!)}</a>`;
  }
  return escapeHtml(token);
}

const MARKDOWN_TOKEN = /```[\s\S]*?```|`[^`\r\n]+`|\*\*[^*\r\n]+\*\*|\[[^\]\r\n]+]\([^\s)]+\)/g;

// Convert only a small, predictable Markdown subset so Telegram HTML never receives raw model markup.
export function formatTelegramText(message: string): string {
  let output = "";
  let position = 0;
  for (const match of message.matchAll(MARKDOWN_TOKEN)) {
    const index = match.index ?? 0;
    output += escapeHtml(message.slice(position, index));
    output += renderToken(match[0]);
    position = index + match[0].length;
  }
  return output + escapeHtml(message.slice(position));
}
