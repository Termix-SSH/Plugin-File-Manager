/** Whether a file opens outside Termix, from a list like "psd, jpg" or "*". */
export function opensExternally(name: string, types: unknown): boolean {
  if (typeof types !== "string" || !types.trim()) return false;
  const list = types
    .split(/[\s,;]+/)
    .map((type) =>
      type
        .trim()
        .replace(/^\*?\./, "")
        .toLowerCase(),
    )
    .filter(Boolean);
  if (list.includes("*")) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return list.includes(name.slice(dot + 1).toLowerCase());
}
