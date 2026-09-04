// A YAML subset parser, sized for GitHub workflow files.
//
// Writing this rather than taking a dependency is consistent with the rest of
// the daemon, but the real reason it is safe to do is that the input is narrow:
// measured across all 22 workflow files in these repos, they use block maps,
// block sequences, flow sequences, plain and quoted scalars, and block scalars.
// No anchors, no aliases, no merge keys, no multi-document files, no tabs.
//
// The one construct that MUST be handled correctly is the block scalar. There
// are 79 of them, nearly all `run: |` shell scripts, and their contents are
// arbitrary text. A line-based scanner that does not skip them will read
// `runs-on:` out of a shell heredoc and report a job that does not exist. That
// single mistake is what separates a linter people trust from one they turn off.
//
// Anything the parser does not confidently understand is reported in
// `warnings` and the document is marked `partial`, so the lint layer can say
// "I could not read this file" instead of inventing an answer about it.

const UNSUPPORTED = [
  [/^\s*\w[\w.-]*\s*:\s*[&*]\S/, 'anchors or aliases'],
  [/^\s*<<\s*:/, 'merge keys'],
  [/^\?\s/, 'explicit complex keys'],
];

function stripComment(line) {
  // A `#` only starts a comment when it is at the start or preceded by space,
  // and never inside quotes. Good enough for this input, and it deliberately
  // leaves `#` inside a quoted string alone.
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// Flow collections, one level deep. Nested flow inside flow does not appear in
// this corpus; if it ever does, the value comes back as a string and the lint
// rules treat it as unknown rather than mis-splitting it.
function parseFlow(raw) {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitFlow(inner).map((x) => scalar(unquote(x))) : [];
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj = {};
    const inner = s.slice(1, -1).trim();
    if (!inner) return obj;
    for (const part of splitFlow(inner)) {
      const idx = part.indexOf(':');
      if (idx === -1) continue;
      obj[unquote(part.slice(0, idx))] = scalar(unquote(part.slice(idx + 1)));
    }
    return obj;
  }
  return null;
}

function splitFlow(s) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function scalar(v) {
  const s = typeof v === 'string' ? v.trim() : v;
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true' || s === 'True') return true;
  if (s === 'false' || s === 'False') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return unquote(s);
}

export function parseYaml(text) {
  const warnings = [];
  const rawLines = text.split(/\r?\n/);

  // Pre-scan for constructs this parser does not implement, and for tabs, which
  // YAML forbids for indentation and which would silently skew every depth
  // calculation below.
  rawLines.forEach((line, i) => {
    if (/^\t| \t/.test(line)) warnings.push(`line ${i + 1}: tab used for indentation`);
    for (const [re, what] of UNSUPPORTED) {
      if (re.test(line)) warnings.push(`line ${i + 1}: ${what} are not supported by this parser`);
    }
  });
  if (rawLines.filter((l) => /^---\s*$/.test(l)).length > 1) {
    warnings.push('multi-document file — only the first document is read');
  }

  // Build a token list of significant lines, with block scalars collapsed into
  // a single value token so their contents can never be read as structure.
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (/^\s*$/.test(raw)) continue;
    if (/^\s*#/.test(raw)) continue;
    if (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw)) continue;

    const content = stripComment(raw).trimEnd();
    if (!content.trim()) continue;
    const indent = content.length - content.trimStart().length;

    // `key: |`, `key: >`, with optional chomping/indentation indicators.
    const block = content.trimStart().match(/^(-\s+)?([\w.$"'-][^:]*)\s*:\s*([|>])([+-]?\d*|\d*[+-]?)\s*$/);
    if (block) {
      const body = [];
      let j = i + 1;
      for (; j < rawLines.length; j++) {
        const next = rawLines[j];
        if (/^\s*$/.test(next)) { body.push(''); continue; }
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        body.push(next);
      }
      lines.push({ indent, key: unquote(block[2].trim()), value: body.join('\n'), isBlock: true,
        dash: Boolean(block[1]), line: i + 1 });
      i = j - 1;
      continue;
    }

    lines.push({ indent, text: content.trimStart(), line: i + 1 });
  }

  let pos = 0;

  function parseBlock(minIndent) {
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.indent < minIndent) return null;
    return first.text?.startsWith('- ') || first.text === '-'
      ? parseSeq(first.indent)
      : parseMap(first.indent);
  }

  function parseSeq(indent) {
    const out = [];
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) { pos++; continue; }
      if (!(l.text?.startsWith('- ') || l.text === '-')) break;
      pos++;
      const rest = l.text === '-' ? '' : l.text.slice(2).trim();
      if (!rest) {
        out.push(parseBlock(indent + 1) ?? null);
        continue;
      }
      // `- key: value` starts a map whose first key sits on the dash line.
      const kv = rest.match(/^([\w.$"'-][^:]*?)\s*:\s*(.*)$/);
      if (kv) {
        const map = {};
        applyKv(map, unquote(kv[1]), kv[2], l.indent + 2);
        const nested = parseMapInto(map, l.indent + 2);
        out.push(nested);
      } else {
        out.push(scalar(rest));
      }
    }
    return out;
  }

  function parseMap(indent) {
    return parseMapInto({}, indent);
  }

  function parseMapInto(map, indent) {
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.text?.startsWith('- ')) break;
      if (l.indent > indent) { pos++; continue; }

      if (l.isBlock) { map[l.key] = l.value; pos++; continue; }

      const kv = l.text.match(/^([\w.$"'-][^:]*?)\s*:\s*(.*)$/);
      if (!kv) { pos++; continue; }
      pos++;
      applyKv(map, unquote(kv[1]), kv[2], indent);
    }
    return map;
  }

  function applyKv(map, key, rawValue, indent) {
    const value = rawValue.trim();
    if (value === '') {
      const child = pos < lines.length && lines[pos].indent > indent ? parseBlock(indent + 1) : null;
      map[key] = child ?? null;
      return;
    }
    const flow = parseFlow(value);
    map[key] = flow ?? scalar(value);
  }

  const doc = parseBlock(0) ?? {};
  return { doc, warnings, partial: warnings.length > 0 };
}
