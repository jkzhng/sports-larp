// Per-browser conveniences (watched games, spoiler shield). Storage can be
// unavailable (private windows, blocked site data), so every access is guarded.

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not persisted; the app still works for this visit.
  }
}
