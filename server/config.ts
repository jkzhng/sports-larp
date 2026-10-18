import { fileURLToPath } from 'node:url'

export const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url))
export const RAW_DIR = `${DATA_DIR}raw`
export const DB_PATH = process.env.SPORTS_LARP_DB ?? `${DATA_DIR}sports-larp.db`

/** NFL season a date falls in: the season that kicks off in September runs into the next February. */
export function currentSeason(now: Date): number {
  return now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1
}
