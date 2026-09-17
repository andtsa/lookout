// ─── Description markdown ─────────────────────────────────────────────────────
// A deliberately tiny markdown subset for node / edge descriptions (and help
// prose):
//   - lines starting `- ` or `* ` → bullet list; `1. ` / `1) ` → numbered list
//   - a blank line → paragraph break
//   - `backtick` runs → inline code
// Everything else — emphasis, links, headings, nested lists — stays literal
// text, so globs like `*_agent.toml` can't be misread as markup. A line that
// isn't a list item ends the list (no continuation lines).
//
// Line breaks only survive in YAML literal blocks (`description: |`); folded
// blocks (`>-`) join lines with spaces, so they never contain lists.
//
// Output is built from DOM nodes, never innerHTML, so a description can't
// inject markup.

const BULLET   = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const CODE     = /`([^`]+)`/;   // an unpaired backtick stays literal

// Group lines into blocks: { type: 'p' | 'ul' | 'ol', lines, start }.
function parseBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    const type = b ? 'ul' : n ? 'ol' : line.trim() ? 'p' : null;
    if (!type) { cur = null; continue; }            // blank line ends any block
    if (!cur || cur.type !== type) {
      blocks.push(cur = { type, lines: [], start: n ? Number(n[1]) : 1 });
    }
    cur.lines.push(b ? b[1] : n ? n[2] : line);
  }
  return blocks;
}

// Append `text` to `el`, rendering backtick runs as <code class="md-code">.
export function appendInline(el, text) {
  String(text).split(CODE).forEach((part, i) => {  // odd indices are the code runs
    if (i % 2 === 1) {
      const code = document.createElement('code');
      code.className   = 'md-code';
      code.textContent = part;
      el.appendChild(code);
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  });
}

// Replace `el`'s contents with the rendered description.
export function renderMarkdown(el, text) {
  el.replaceChildren();
  for (const block of parseBlocks(text)) {
    if (block.type === 'p') {
      const p = document.createElement('p');
      appendInline(p, block.lines.join('\n'));
      el.appendChild(p);
      continue;
    }
    const list = document.createElement(block.type);
    if (block.type === 'ol' && block.start !== 1) list.start = block.start;
    for (const item of block.lines) {
      const li = document.createElement('li');
      appendInline(li, item);
      list.appendChild(li);
    }
    el.appendChild(list);
  }
}

// Single-line plain-text form, for places that can't hold markup (the SVG
// inline caption): markers and backticks dropped, paragraphs and list items
// joined by ' · '.
export function markdownToPlainText(text) {
  return parseBlocks(text)
    .flatMap(block => (block.type === 'p' ? [block.lines.join(' ')] : block.lines))
    .map(line => line.replace(new RegExp(CODE.source, 'g'), '$1').trim())
    .join(' · ');
}
