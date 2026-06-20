export async function searchSpenderClub(query: string): Promise<string> {
  const startTime = Date.now()
  try {
    const url = `https://www.spenderclub.com/?s=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'websearch.result',
      query,
      status: res.status,
      ok: res.ok,
      latencyMs: Date.now() - startTime,
    }))

    if (!res.ok) return ''

    const html = await res.text()
    const text = stripHtml(html)
    const result = text.slice(0, 3000)

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'websearch.content',
      query,
      contentLength: result.length,
      hasContent: result.length > 100,
    }))

    return result
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      event: 'websearch.failed',
      query,
      err: (err as Error).message,
      latencyMs: Date.now() - startTime,
    }))
    return ''
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
