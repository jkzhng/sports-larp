// ESPN NBA team abbreviations with the names the NBA's YouTube channel uses in
// titles ("TRAIL BLAZERS at 76ERS").
export const NBA_TEAMS: Record<string, { city: string; nickname: string }> = {
  ATL: { city: 'Atlanta', nickname: 'Hawks' },
  BKN: { city: 'Brooklyn', nickname: 'Nets' },
  BOS: { city: 'Boston', nickname: 'Celtics' },
  CHA: { city: 'Charlotte', nickname: 'Hornets' },
  CHI: { city: 'Chicago', nickname: 'Bulls' },
  CLE: { city: 'Cleveland', nickname: 'Cavaliers' },
  DAL: { city: 'Dallas', nickname: 'Mavericks' },
  DEN: { city: 'Denver', nickname: 'Nuggets' },
  DET: { city: 'Detroit', nickname: 'Pistons' },
  GS: { city: 'Golden State', nickname: 'Warriors' },
  HOU: { city: 'Houston', nickname: 'Rockets' },
  IND: { city: 'Indiana', nickname: 'Pacers' },
  LAC: { city: 'LA', nickname: 'Clippers' },
  LAL: { city: 'Los Angeles', nickname: 'Lakers' },
  MEM: { city: 'Memphis', nickname: 'Grizzlies' },
  MIA: { city: 'Miami', nickname: 'Heat' },
  MIL: { city: 'Milwaukee', nickname: 'Bucks' },
  MIN: { city: 'Minnesota', nickname: 'Timberwolves' },
  NO: { city: 'New Orleans', nickname: 'Pelicans' },
  NY: { city: 'New York', nickname: 'Knicks' },
  OKC: { city: 'Oklahoma City', nickname: 'Thunder' },
  ORL: { city: 'Orlando', nickname: 'Magic' },
  PHI: { city: 'Philadelphia', nickname: '76ers' },
  PHX: { city: 'Phoenix', nickname: 'Suns' },
  POR: { city: 'Portland', nickname: 'Trail Blazers' },
  SA: { city: 'San Antonio', nickname: 'Spurs' },
  SAC: { city: 'Sacramento', nickname: 'Kings' },
  TOR: { city: 'Toronto', nickname: 'Raptors' },
  UTAH: { city: 'Utah', nickname: 'Jazz' },
  WSH: { city: 'Washington', nickname: 'Wizards' },
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

/** Team abbreviation for a nickname as written in a title ("TRAIL BLAZERS", "#4 PACERS"). */
export function nbaTeamFromName(name: string): string | null {
  const n = norm(name.replace(/#\d+/g, ''))
  const hits = Object.keys(NBA_TEAMS).filter((abbr) => {
    const t = NBA_TEAMS[abbr]
    return n === norm(t.nickname) || n === norm(`${t.city} ${t.nickname}`)
  })
  return hits.length === 1 ? hits[0] : null
}
