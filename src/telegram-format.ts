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

const INLINE_MARKDOWN_TOKEN = /`[^`\r\n]+`|\*\*[^*\r\n]+\*\*|\[[^\]\r\n]+]\([^\s)]+\)/g;
const FENCED_CODE_TOKEN = /```[\s\S]*?```/g;

function formatInline(value: string): string {
  let output = "";
  let position = 0;
  for (const match of value.matchAll(INLINE_MARKDOWN_TOKEN)) {
    const index = match.index ?? 0;
    output += escapeHtml(value.slice(position, index));
    output += renderToken(match[0]);
    position = index + match[0].length;
  }
  return output + escapeHtml(value.slice(position));
}

function headingText(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, "$1")
    .replace(/[\*`]/g, "")
    .trim();
}

function formatProse(value: string): string {
  return value
    .split(/(\r?\n)/)
    .map((line) => {
      if (/^\r?\n$/.test(line)) return line;
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading) return `<b>${escapeHtml(headingText(heading[1]!))}</b>`;
      if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) return "────────";
      const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (bullet) return `${escapeHtml(bullet[1]!)}• ${formatInline(bullet[2]!)}`;
      return formatInline(line);
    })
    .join("");
}

// Convert only a small, predictable Markdown subset so Telegram HTML never receives raw model markup.
export function formatTelegramText(message: string): string {
  let output = "";
  let position = 0;
  for (const match of message.matchAll(FENCED_CODE_TOKEN)) {
    const index = match.index ?? 0;
    output += formatProse(message.slice(position, index));
    output += renderToken(match[0]);
    position = index + match[0].length;
  }
  return output + formatProse(message.slice(position));
}
