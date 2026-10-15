/**
 * Recognize the pinned CLI's UTF-8, middle-out text truncation. The token budget
 * is not recorded in the rollout, so derive a candidate from the omitted-token
 * count and then verify the entire transformation against the original text.
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
  return undefined;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
