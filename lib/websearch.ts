import { redis } from './redis'

export type SearchResult = { text: string; url: string }

type SerperOrganic = { title: string; snippet: string; link: string }
type SerperResponse = { organic?: SerperOrganic[] }

const SEARCH_CACHE_TTL = 24 * 3600 // 24 ชั่วโมง

// ค้นหาจาก spenderclub.com + spendernetwork.com (มี Redis cache 24h)
export async function searchSpenderSites(query: string): Promise<SearchResult> {
  const cacheKey = `search_cache:${query.slice(0, 120)}`

  // ตรวจ cache ก่อน
  try {
    const cached = await redis.get<SearchResult>(cacheKey)
    if (cached) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'search.cache_hit', query }))
      return cached
    }
  } catch { /* Redis ล่ม — ข้าม */ }

  const apiKey = process.env.SERPER_API_KEY
  const result = apiKey
    ? await searchWithSerper(query, apiKey)
    : await searchWithScraping(query)

  // บันทึก cache ถ้าได้ผลลัพธ์
  if (result.text) {
    try {
      await redis.set(cacheKey, result, { ex: SEARCH_CACHE_TTL })
    } catch { /* Redis ล่ม — ข้าม */ }
  }

  return result
}

// backward compat — ใช้ใน generateReplyWithImage
export async function searchSpenderClub(query: string): Promise<string> {
  const result = await searchSpenderSites(query)
  return result.text
}

async function searchWithSerper(query: string, apiKey: string): Promise<SearchResult> {
  const startTime = Date.now()
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: `${query} (site:spenderclub.com OR site:spendernetwork.com)`,
        num: 5,
        gl: 'th',
        hl: 'th',
      }),
      signal: AbortSignal.timeout(5000),
    })

    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'info', event: 'serper.result',
      status: res.status, latencyMs: Date.now() - startTime,
    }))

    if (!res.ok) return { text: '', url: '' }

    const data = (await res.json()) as SerperResponse
    const organic = data.organic ?? []
    if (organic.length === 0) return { text: '', url: '' }

    const text = organic.map(r => `${r.title}\n${r.snippet}`).join('\n\n').slice(0, 3000)
    return { text, url: organic[0].link }
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'serper.failed',
      err: (err as Error).message, latencyMs: Date.now() - startTime,
    }))
    return { text: '', url: '' }
  }
}

async function searchWithScraping(query: string): Promise<SearchResult> {
  const startTime = Date.now()
  const url = `https://www.spenderclub.com/?s=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })

    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'info', event: 'websearch.scrape',
      status: res.status, latencyMs: Date.now() - startTime,
    }))

    if (!res.ok) return { text: '', url }
    const html = await res.text()
    const text = stripHtml(html).slice(0, 3000)
    return { text, url }
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', event: 'websearch.failed',
      err: (err as Error).message,
    }))
    return { text: '', url }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
