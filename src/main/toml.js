'use strict';
// The few TOML forms the app writes for the daemons it runs: strings,
// integers, booleans, arrays of those, tables and arrays of tables, from a
// plain object. Strings are written as TOML basic strings with every control
// character escaped, so a value can never end its line or open a key.

// eslint-disable-next-line no-control-regex -- escaping every control character is the point
const ESCAPE = /[\\"\u0000-\u001f\u007f]/g;
function str(s) {
  return `"${String(s).replace(ESCAPE, (c) => {
    if (c === '\\') return '\\\\';
    if (c === '"') return '\\"';
    if (c === '\n') return '\\n';
    if (c === '\t') return '\\t';
    if (c === '\r') return '\\r';
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  })}"`;
}

function key(k) { return /^[A-Za-z0-9_-]+$/.test(k) ? k : str(k); }

function value(v) {
  if (typeof v === 'string') return str(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`not an integer: ${v}`);
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(value).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => `${key(k)} = ${value(x)}`).join(', ')} }`;
  throw new Error(`no TOML form for ${typeof v}`);
}

function isTable(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function isTableArray(v) { return Array.isArray(v) && v.length > 0 && v.every(isTable); }

// `obj` as a TOML document. Plain values first, then each table under its
// header, then each array of tables; `comments` maps a dotted path to a
// comment line written above it.
function stringify(obj, prefix = '', comments = {}) {
  const lines = [];
  const note = (p) => { if (comments[p]) for (const l of String(comments[p]).split('\n')) lines.push(`# ${l}`); };
  const plain = Object.entries(obj).filter(([, v]) => v != null && !isTable(v) && !isTableArray(v));
  for (const [k, v] of plain) { note(prefix + k); lines.push(`${key(k)} = ${value(v)}`); }
  for (const [k, v] of Object.entries(obj).filter(([, x]) => isTable(x))) {
    const p = prefix + k;
    lines.push('');
    note(p);
    lines.push(`[${p}]`);
    const inner = stringify(v, `${p}.`, comments);
    if (inner) lines.push(inner);
  }
  for (const [k, arr] of Object.entries(obj).filter(([, x]) => isTableArray(x))) {
    const p = prefix + k;
    for (const t of arr) {
      lines.push('');
      note(p);
      lines.push(`[[${p}]]`);
      const plainT = Object.fromEntries(Object.entries(t).filter(([, x]) => !isTable(x)));
      const tables = Object.fromEntries(Object.entries(t).filter(([, x]) => isTable(x)));
      const a = stringify(plainT, `${p}.`, comments);
      if (a) lines.push(a);
      for (const [tk, tv] of Object.entries(tables)) {
        lines.push(`[${p}.${tk}]`);
        const b = stringify(tv, `${p}.${tk}.`, comments);
        if (b) lines.push(b);
      }
    }
  }
  return lines.join('\n').replace(/^\n+/, '');
}

module.exports = { stringify, str };
