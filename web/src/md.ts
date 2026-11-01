/** Minimal Markdown for reports (headings, lists, bold, code, quotes) with clickable ev_N ids. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\b(ev_\d+)\b/g, '<a class="ev" href="javascript:void 0" data-ev="$1">$1</a>');
}

export function md(src: string): string {
  const out: string[] = [];
  let list = false;
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(li[1]!)}</li>`);
      continue;
    }
    if (list) {
      out.push('</ul>');
      list = false;
    }
    const hd = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hd) out.push(`<h${hd[1]!.length}>${inline(hd[2]!)}</h${hd[1]!.length}>`);
    else if (line.startsWith('>')) out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    else if (line.startsWith('<!--')) continue;
    else if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}
