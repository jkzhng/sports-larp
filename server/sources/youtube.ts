import type { Upload } from '../highlights.ts'

const PLAYLIST_ITEMS_URL = 'https://www.googleapis.com/youtube/v3/playlistItems'

export const NFL_CHANNEL_ID = 'UCDVYQ4Zhbm3S2dlz7P1GBDg'
export const NBA_CHANNEL_ID = 'UCWJ2lWNubArHWmf3FIHbfcQ'

// Only videos owned by these channels are ever stored or shown.
export const ALLOWED_CHANNELS = new Set([NFL_CHANNEL_ID, NBA_CHANNEL_ID])

interface PlaylistItemsResponse {
  nextPageToken?: string
  items: {
    snippet: { title: string; videoOwnerChannelId?: string; resourceId: { videoId: string } }
    contentDetails: { videoId: string; videoPublishedAt?: string }
  }[]
}

/**
 * A channel's uploads, newest first, back to `since`. Reads the uploads playlist
 * (1 quota unit per 50 videos) rather than search (100 units per call).
 */
export async function fetchUploads(channelId: string, since: Date, apiKey: string, maxPages = 20): Promise<Upload[]> {
  if (!ALLOWED_CHANNELS.has(channelId)) throw new Error(`channel ${channelId} is not on the allow-list`)
  const playlistId = `UU${channelId.slice(2)}`
  const out: Upload[] = []
  let pageToken: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ part: 'snippet,contentDetails', playlistId, maxResults: '50', key: apiKey })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(`${PLAYLIST_ITEMS_URL}?${params}`)
    if (!res.ok) throw new Error(`YouTube playlistItems failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as PlaylistItemsResponse
    let reachedSince = false
    for (const item of body.items) {
      const publishedAt = item.contentDetails.videoPublishedAt
      if (!publishedAt) continue // private or deleted
      if (Date.parse(publishedAt) < since.getTime()) {
        reachedSince = true
        continue
      }
      const owner = item.snippet.videoOwnerChannelId ?? channelId
      if (!ALLOWED_CHANNELS.has(owner)) continue
      out.push({ videoId: item.contentDetails.videoId, channelId: owner, title: item.snippet.title, publishedAt })
    }
    pageToken = body.nextPageToken
    if (reachedSince || !pageToken) break
  }
  return out
}
