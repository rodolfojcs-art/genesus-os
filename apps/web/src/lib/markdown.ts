/**
 * Renderizador markdown ligero con soporte de enlaces [[wiki]] (estilo Obsidian).
 * Sin dependencias. Escapa HTML y luego aplica formato seguro.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text: string): string {
  let t = escapeHtml(text);
  // Código en línea
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Enlaces wiki [[Nota]] o [[Nota|alias]]
  t = t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ?? target).trim();
    return `<a class="wikilink" data-wikilink="${escapeHtml(target.trim())}" href="#">${escapeHtml(label)}</a>`;
  });
  // Enlaces markdown [texto](url)
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  // Negrita / itálica
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  return t;
}

/** Convierte markdown (sin frontmatter) a HTML. */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/^---\n[\s\S]*?\n---\n?/, '').split('\n');
  const html: string[] = [];
  let inCode = false;
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('```')) {
      closeList();
      if (inCode) {
        html.push('</code></pre>');
        inCode = false;
      } else {
        html.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(raw));
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1]!.length;
      html.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      html.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^(---|\*\*\*)$/.test(line)) {
      closeList();
      html.push('<hr/>');
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}
