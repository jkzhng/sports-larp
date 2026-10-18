// One play-by-play row. Field names match nflverse columns so the Python notebook
// and this job read the same data the same way.
export interface Play {
  game_id: string
  seq: number // row order within the game, as published
  qtr: number | null
  game_seconds_remaining: number | null
  posteam: string | null
  play_type: string | null
  yards_gained: number | null
  sack: number | null
  touchdown: number | null
  td_team: string | null
  special_teams_play: number | null
  interception: number | null
  fumble_lost: number | null
  fourth_down_failed: number | null
  home_wp: number | null
  vegas_home_wp: number | null
  wpa: number | null
  total_home_score: number | null
  total_away_score: number | null
  desc: string | null
  // Recap-only fields.
  quarter_seconds_remaining: number | null
  defteam: string | null
  passer_player_name: string | null
  receiver_player_name: string | null
  rusher_player_name: string | null
  passing_yards: number | null
  receiving_yards: number | null
  rushing_yards: number | null
  complete_pass: number | null
  pass_attempt: number | null
  rush_attempt: number | null
  pass_touchdown: number | null
  rush_touchdown: number | null
  two_point_attempt: number | null
  interception_player_name: string | null
  sack_player_name: string | null
  half_sack_1_player_name: string | null
  half_sack_2_player_name: string | null
}

/** Every Play field read from the nflverse parquet and stored in `plays` (all but seq). */
export const PLAY_COLUMNS = [
  'game_id', 'qtr', 'game_seconds_remaining', 'posteam', 'play_type', 'yards_gained', 'sack',
  'touchdown', 'td_team', 'special_teams_play', 'interception', 'fumble_lost', 'fourth_down_failed',
  'home_wp', 'vegas_home_wp', 'wpa', 'total_home_score', 'total_away_score', 'desc',
  'quarter_seconds_remaining', 'defteam', 'passer_player_name', 'receiver_player_name',
  'rusher_player_name', 'passing_yards', 'receiving_yards', 'rushing_yards', 'complete_pass',
  'pass_attempt', 'rush_attempt', 'pass_touchdown', 'rush_touchdown', 'two_point_attempt',
  'interception_player_name', 'sack_player_name', 'half_sack_1_player_name', 'half_sack_2_player_name',
] as const satisfies readonly (keyof Play)[]

// One row of nflverse's games.csv (only the columns we use).
export interface ScheduleGame {
  game_id: string
  season: number
  game_type: string // REG, WC, DIV, CON, SB
  week: number
  gameday: string // YYYY-MM-DD, Eastern
  weekday: string
  gametime: string // HH:MM, Eastern
  away_team: string
  home_team: string
  away_score: number | null
  home_score: number | null
  result: number | null // home minus away; null until final
  div_game: number
  spread_line: number | null
}
