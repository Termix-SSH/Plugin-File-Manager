/**
 * Drops trailing characters in a single pass. A regex like /\/+$/ backtracks
 * on long runs and takes quadratic time on a long request path.
 */
export function trimEnd(value: string, chars = "/"): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
}
