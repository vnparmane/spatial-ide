/** Subsequence score that rewards contiguous and word-boundary matches. */
export function scoreSubsequence(text: string, needle: string): number {
  const haystack = text.toLowerCase();
  let hayIndex = 0;
  let needleIndex = 0;
  let score = 0;
  let lastMatch = -2;

  while (hayIndex < haystack.length && needleIndex < needle.length) {
    if (haystack[hayIndex] === needle[needleIndex]) {
      score += lastMatch === hayIndex - 1 ? 9 : 2;
      const previous = haystack[hayIndex - 1];
      if (
        hayIndex === 0 ||
        previous === '/' ||
        previous === '-' ||
        previous === '_' ||
        previous === '.' ||
        previous === ' '
      ) {
        score += 5;
      }
      lastMatch = hayIndex;
      needleIndex += 1;
    }
    hayIndex += 1;
  }

  if (needleIndex !== needle.length) return -1;
  return score - haystack.length * 0.01;
}

/** Every whitespace-separated token must match somewhere in the text. */
export function scoreTokens(text: string, query: string): number {
  if (!query) return 0;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const token of tokens) {
    const score = scoreSubsequence(text, token);
    if (score < 0) return -1;
    total += score;
  }
  return total / tokens.length;
}
