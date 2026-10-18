// nflverse team abbreviations with the names official channels use in titles.
export const NFL_TEAMS: Record<string, { city: string; nickname: string }> = {
  ARI: { city: 'Arizona', nickname: 'Cardinals' },
  ATL: { city: 'Atlanta', nickname: 'Falcons' },
  BAL: { city: 'Baltimore', nickname: 'Ravens' },
  BUF: { city: 'Buffalo', nickname: 'Bills' },
  CAR: { city: 'Carolina', nickname: 'Panthers' },
  CHI: { city: 'Chicago', nickname: 'Bears' },
  CIN: { city: 'Cincinnati', nickname: 'Bengals' },
  CLE: { city: 'Cleveland', nickname: 'Browns' },
  DAL: { city: 'Dallas', nickname: 'Cowboys' },
  DEN: { city: 'Denver', nickname: 'Broncos' },
  DET: { city: 'Detroit', nickname: 'Lions' },
  GB: { city: 'Green Bay', nickname: 'Packers' },
  HOU: { city: 'Houston', nickname: 'Texans' },
  IND: { city: 'Indianapolis', nickname: 'Colts' },
  JAX: { city: 'Jacksonville', nickname: 'Jaguars' },
  KC: { city: 'Kansas City', nickname: 'Chiefs' },
  LA: { city: 'Los Angeles', nickname: 'Rams' },
  LAC: { city: 'Los Angeles', nickname: 'Chargers' },
  LV: { city: 'Las Vegas', nickname: 'Raiders' },
  MIA: { city: 'Miami', nickname: 'Dolphins' },
  MIN: { city: 'Minnesota', nickname: 'Vikings' },
  NE: { city: 'New England', nickname: 'Patriots' },
  NO: { city: 'New Orleans', nickname: 'Saints' },
  NYG: { city: 'New York', nickname: 'Giants' },
  NYJ: { city: 'New York', nickname: 'Jets' },
  PHI: { city: 'Philadelphia', nickname: 'Eagles' },
  PIT: { city: 'Pittsburgh', nickname: 'Steelers' },
  SEA: { city: 'Seattle', nickname: 'Seahawks' },
  SF: { city: 'San Francisco', nickname: '49ers' },
  TB: { city: 'Tampa Bay', nickname: 'Buccaneers' },
  TEN: { city: 'Tennessee', nickname: 'Titans' },
  WAS: { city: 'Washington', nickname: 'Commanders' },
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/**
 * Team abbreviation for a name as written in a video title ("New Orleans Saint",
 * "Bills", "Washington"). Matches the nickname with up to one typo, then falls
 * back to a city that only one team uses. Null when ambiguous or unknown.
 */
export function teamFromName(name: string): string | null {
  const words = norm(name).split(' ')
  const last = words.at(-1) ?? ''
  const byNickname = Object.keys(NFL_TEAMS).filter((abbr) => {
    const nick = norm(NFL_TEAMS[abbr].nickname)
    return last === nick || (last.length >= 4 && editDistance(last, nick) <= 1)
  })
  if (byNickname.length === 1) return byNickname[0]

  const full = norm(name)
  const byCity = Object.keys(NFL_TEAMS).filter((abbr) => full === norm(NFL_TEAMS[abbr].city))
  return byCity.length === 1 ? byCity[0] : null
}
