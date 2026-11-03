/**
 * Recognize the pinned CLI's UTF-8, middle-out text truncation. Budgets are not
 * recorded in the rollout, so verify a candidate against the entire original.
 * Return a token budget for the tokens marker or a byte budget for chars.
 */
export function codexTruncationBudget(
  original: string,
  observed: string,
): number | undefined {
  const source = Buffer.from(original);
  const result = Buffer.from(observed);
  // Buffer must not silently replace malformed UTF-16 while comparing evidence.
  if (source.toString() !== original || result.toString() !== observed)
    return undefined;
  const sourceTokens = Math.ceil(source.length / 4);
  // Latin-1 makes regex offsets byte offsets; it does not reinterpret the text.
  const markers = result
    .toString('latin1')
    .matchAll(/\xE2\x80\xA6([1-9][0-9]*) tokens truncated\xE2\x80\xA6/g);
  for (const match of markers) {
    const omitted = Number(match[1]);
    const budget = sourceTokens - omitted;
    if (!Number.isSafeInteger(omitted) || budget <= 0) continue;
    const halfBytes = budget * 2;
    const prefixLength = match.index;
    const suffixStart = prefixLength + match[0].length;
    const suffixLength = result.length - suffixStart;
    // UTF-8 rounding can lose at most three bytes on either side. Filter before
    // comparing buffers, so many literal markers cannot cause quadratic work.
    if (
      prefixLength > halfBytes ||
      prefixLength < halfBytes - 3 ||
      suffixLength > halfBytes ||
      suffixLength < halfBytes - 3
    )
      continue;
    let prefixEnd = halfBytes;
    let sourceSuffix = source.length - halfBytes;
    while (isContinuation(source[prefixEnd])) prefixEnd -= 1;
    while (isContinuation(source[sourceSuffix])) sourceSuffix += 1;
    if (
      prefixLength !== prefixEnd ||
      suffixLength !== source.length - sourceSuffix
    )
      continue;
    if (
      source.subarray(0, prefixEnd).equals(result.subarray(0, prefixLength)) &&
      source.subarray(sourceSuffix).equals(result.subarray(suffixStart))
    )
      return budget;
  }
  return codexCharsTruncationBudget(source, result);
}

// Codex 0.149.0 utils/string/src/truncate.rs:38–68,86–144: the chars
// marker counts omitted Unicode scalars after rounding a UTF-8 byte budget.
function codexCharsTruncationBudget(
  source: Buffer,
  result: Buffer,
): number | undefined {
  const markers = result
    .toString('latin1')
    .matchAll(/\xE2\x80\xA6([1-9][0-9]*) chars truncated\xE2\x80\xA6/g);
  for (const match of markers) {
    const omitted = Number(match[1]);
    if (!Number.isSafeInteger(omitted)) continue;
    const prefixLength = match.index;
    const suffixStart = prefixLength + match[0].length;
    const suffixLength = result.length - suffixStart;
    // Each end loses at most three bytes to rounding; an odd budget gives the
    // tail one extra byte. Filter before any full comparisons or scalar scans
    // so literal markers cannot cause quadratic work.
    if (Math.abs(prefixLength - suffixLength) > 4) continue;
    const sourceSuffix = source.length - suffixLength;
    if (prefixLength >= sourceSuffix) continue;
    if (
      !source.subarray(0, prefixLength).equals(result.subarray(0, prefixLength)) ||
      !source.subarray(sourceSuffix).equals(result.subarray(suffixStart))
    )
      continue;
    let removedChars = 0;
    for (const _ of source.subarray(prefixLength, sourceSuffix).toString())
      removedChars += 1;
    if (removedChars !== omitted) continue;
    // The scalar count does not uniquely determine a byte budget. Derive the
    // smallest candidate retaining both ends, then verify its rounded split.
    const budget = Math.max(prefixLength * 2, suffixLength * 2 - 1);
    let prefixEnd = Math.floor(budget / 2);
    let suffix = source.length - (budget - prefixEnd);
    while (isContinuation(source[prefixEnd])) prefixEnd -= 1;
    while (isContinuation(source[suffix])) suffix += 1;
    if (prefixEnd === prefixLength && suffix === sourceSuffix) return budget;
  }
  return undefined;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
