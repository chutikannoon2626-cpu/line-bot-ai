export async function searchSpenderClub(query: string): Promise<string> {
  try {
    const url = `https://www.spenderclub.com/?s=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpenderBot/1.0)' },
    })
    if (!res.ok) return ''

    const html = await res.text()
    const text = stripHtml(html)
    // คืนแค่ 2,000 ตัวอักษรเพื่อไม่ให้ prompt ใหญ่เกิน
    return text.slice(0, 2000)
  } catch {
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
