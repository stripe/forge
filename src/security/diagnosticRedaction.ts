/** Tail redaction delays the longest possible split secret before releasing bytes. */
export function createRedactedTail(
  secrets: readonly string[],
  maximumBytes: number,
) {
  const values = [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const overlap = Math.max(1, ...values.map((value) => value.length));
  let pending = '';
  let tail = '';
  let truncated = false;
  function drain(final: boolean) {
    let end = 0;
    let output = '';
    while (end < pending.length && (final || pending.length - end >= overlap)) {
      const secret = values.find((value) => pending.startsWith(value, end));
      if (secret) {
        output += '[REDACTED]';
        end += secret.length;
      } else {
        output += pending[end];
        end += 1;
      }
    }
    pending = pending.slice(end);
    const bytes = Buffer.from(tail + output);
    if (bytes.length > maximumBytes) truncated = true;
    tail = bytes
      .subarray(Math.max(0, bytes.length - maximumBytes))
      .toString('utf8');
    // A byte cut may start within a UTF-8 character. Keep the encoded bound too.
    while (Buffer.byteLength(tail) > maximumBytes) tail = tail.slice(1);
  }
  return {
    push(chunk: string) {
      pending += chunk;
      drain(false);
    },
    finish(sourceTruncated = false) {
      if (sourceTruncated) pending = '';
      drain(true);
      return { text: tail, truncated };
    },
  };
}
