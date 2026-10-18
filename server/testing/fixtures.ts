import type { Play } from '../types.ts'

/** A play with neutral defaults; override only what a test cares about. */
export const play = (o: Partial<Play>): Play => ({
  game_id: 'G', seq: 0, qtr: 1, game_seconds_remaining: 3600, posteam: 'HOM', play_type: 'run',
  yards_gained: 0, sack: 0, touchdown: 0, td_team: null, special_teams_play: 0, interception: 0,
  fumble_lost: 0, fourth_down_failed: 0, home_wp: 0.5, vegas_home_wp: 0.5, wpa: 0,
  total_home_score: 0, total_away_score: 0, desc: null,
  quarter_seconds_remaining: 900, defteam: 'AWY', passer_player_name: null, receiver_player_name: null,
  rusher_player_name: null, passing_yards: null, receiving_yards: null, rushing_yards: null,
  complete_pass: 0, pass_attempt: 0, rush_attempt: 0, pass_touchdown: 0, rush_touchdown: 0,
  two_point_attempt: 0, interception_player_name: null, sack_player_name: null,
  half_sack_1_player_name: null, half_sack_2_player_name: null, ...o,
})
