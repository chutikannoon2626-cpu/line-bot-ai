let cache: { data: string; ts: number } | null = null
const CACHE_TTL = 60_000

export async function getFAQ(): Promise<string> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return cache.data
  }
  try {
    const res = await fetch(process.env.SHEET_CSV_URL!, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`)
    const text = await res.text()
    cache = { data: text, ts: Date.now() }
    return text
  } catch (err) {
    console.error('[sheet] fetch error:', err)
    return cache?.data ?? ''
  }
}
