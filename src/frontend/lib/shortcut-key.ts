/**
 * The key a shortcut means on any keyboard layout: event.key, except that a
 * letter typed on a non-Latin layout (Cyrillic, Greek...) reads as the Latin
 * letter on the same key, the way browsers match their own shortcuts. Latin
 * layouts keep their letters, so Dvorak's Ctrl+S is still the S key.
 */
export function shortcutKey(event: { key: string; code: string }): string {
  if (event.key.length !== 1 || /[ -~]/.test(event.key)) return event.key;
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  return letter ? letter.toLowerCase() : event.key;
}
