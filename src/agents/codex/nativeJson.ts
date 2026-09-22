interface Span {
  start: number;
  end: number;
}

const MAX_SOURCE_CODE_UNITS = 1024 * 1024;
const MAX_DEPTH = 64;

/**
 * Select an object-property path from an already JSON.parse-validated, bounded
 * native record. Preserve JSON token spelling and order; remove only JSON
 * whitespace outside strings. Array indexes are deliberately not path keys.
 *
 * This is a span scanner, not a replacement JSON validator. All traversal is
 * iterative. Duplicate decoded keys along the requested path are ambiguous,
 * even when JSON.parse would have chosen their last occurrence.
 */
export function nativeJsonValue(source: string, path: readonly string[]): string | undefined {
  if (source.length > MAX_SOURCE_CODE_UNITS || path.length > MAX_DEPTH) return undefined;
  const start = skipWhitespace(source, 0, source.length);
  const end = valueEnd(source, start, source.length);
  if (end === undefined || skipWhitespace(source, end, source.length) !== source.length) return undefined;
  let selected: Span = {start, end};
  for (const key of path) {
    const next = propertySpan(source, selected, key);
    if (next === undefined) return undefined;
    selected = next;
  }
  return compact(source, selected);
}

function propertySpan(source: string, parent: Span, wanted: string): Span | undefined {
  if (source[parent.start] !== '{' || source[parent.end - 1] !== '}') return undefined;
  const objectEnd = parent.end - 1;
  let cursor = skipWhitespace(source, parent.start + 1, objectEnd);
  let selected: Span | undefined;
  while (cursor < objectEnd) {
    if (source[cursor] !== '"') return undefined;
    const keyEnd = stringEnd(source, cursor, objectEnd);
    if (keyEnd === undefined) return undefined;
    let key: unknown;
    try {
      // Decode just the property-name string, never an object or result value.
      key = JSON.parse(source.slice(cursor, keyEnd));
    } catch {
      return undefined;
    }
    cursor = skipWhitespace(source, keyEnd, objectEnd);
    if (source[cursor] !== ':') return undefined;
    const start = skipWhitespace(source, cursor + 1, objectEnd);
    const end = valueEnd(source, start, objectEnd);
    if (end === undefined) return undefined;
    if (key === wanted) {
      if (selected !== undefined) return undefined;
      selected = {start, end};
    }
    cursor = skipWhitespace(source, end, objectEnd);
    if (cursor === objectEnd) return selected;
    if (source[cursor] !== ',') return undefined;
    cursor = skipWhitespace(source, cursor + 1, objectEnd);
    if (cursor === objectEnd) return undefined;
  }
  return selected;
}

/** Exclusive end of one value, without parsing or reserializing its contents. */
function valueEnd(source: string, start: number, end: number): number | undefined {
  if (start >= end) return undefined;
  const first = source[start];
  if (first === '"') return stringEnd(source, start, end);
  if (first !== '{' && first !== '[') {
    let cursor = start;
    while (cursor < end && !isWhitespace(source.charCodeAt(cursor)) &&
           source[cursor] !== ',' && source[cursor] !== ']' && source[cursor] !== '}') cursor += 1;
    return cursor === start ? undefined : cursor;
  }

  const closing = [first === '{' ? '}' : ']'];
  let cursor = start + 1;
  while (cursor < end) {
    const character = source[cursor];
    if (character === '"') {
      const next = stringEnd(source, cursor, end);
      if (next === undefined) return undefined;
      cursor = next;
      continue;
    }
    if (character === '{' || character === '[') {
      closing.push(character === '{' ? '}' : ']');
      if (closing.length > MAX_DEPTH) return undefined;
    } else if (character === '}' || character === ']') {
      if (closing.pop() !== character) return undefined;
      if (closing.length === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return undefined;
}

function stringEnd(source: string, start: number, end: number): number | undefined {
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    if (source[cursor] === '\\') cursor += 1;
    else if (source[cursor] === '"') return cursor + 1;
  }
  return undefined;
}

function compact(source: string, span: Span): string | undefined {
  const chunks: string[] = [];
  let chunkStart = span.start;
  let cursor = span.start;
  while (cursor < span.end) {
    if (source[cursor] === '"') {
      const next = stringEnd(source, cursor, span.end);
      if (next === undefined) return undefined;
      cursor = next;
    } else if (isWhitespace(source.charCodeAt(cursor))) {
      if (chunkStart < cursor) chunks.push(source.slice(chunkStart, cursor));
      cursor = skipWhitespace(source, cursor, span.end);
      chunkStart = cursor;
    } else cursor += 1;
  }
  if (chunkStart < span.end) chunks.push(source.slice(chunkStart, span.end));
  return chunks.join('');
}

function skipWhitespace(source: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && isWhitespace(source.charCodeAt(cursor))) cursor += 1;
  return cursor;
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}
