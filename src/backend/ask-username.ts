/** A host username of "$ask" means: ask who to log in as on every connect. */
export function isAskUsername(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "$ask";
}

/** A login name a server would take: no spaces, quotes or control marks. */
export function isValidLoginName(value: string): boolean {
  return value !== "$ask" && /^[A-Za-z0-9_][A-Za-z0-9._@$-]{0,63}$/.test(value);
}
