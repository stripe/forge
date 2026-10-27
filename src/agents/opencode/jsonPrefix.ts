/** Whether missing trailing syntax can complete this JSON, without repairing its interior. */
export function isJsonPrefix(text: string): boolean {
  const closing: string[] = [];
  let inString = false;
  let escaped = false;
  let tokenStart = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    switch (character) {
      case '"':
        inString = true;
        tokenStart = index;
        break;
      case '{':
        closing.push('}');
        tokenStart = index + 1;
        break;
      case '[':
        closing.push(']');
        tokenStart = index + 1;
        break;
      case '}':
      case ']':
        if (closing.pop() !== character) return false;
        tokenStart = index + 1;
        break;
      case ':':
      case ',':
        tokenStart = index + 1;
        break;
    }
  }

  let suffixes: string[];
  if (inString) {
    // Padding finishes a split unicode escape; the second form finishes a key.
    const stringEnd = escaped ? 'u0000"' : '0000"';
    suffixes = [stringEnd, `${stringEnd}:null`];
  } else {
    const token = text.slice(tokenStart).trim();
    const literal = ['true', 'false', 'null'].find((value) =>
      value.startsWith(token),
    );
    suffixes = token
      ? ['', '0', ':null', ...(literal ? [literal.slice(token.length)] : [])]
      : ['', 'null', '"":null'];
  }
  const end = closing.reverse().join('');
  return suffixes.some((suffix) => {
    try {
      JSON.parse(text + suffix + end);
      return true;
    } catch {
      return false;
    }
  });
}
