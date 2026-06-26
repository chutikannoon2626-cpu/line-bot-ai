let cache: { text: string; expiresAt: number } | null = null
const CACHE_TTL_MS = 60_000

export async function fetchFAQ(): Promise<string> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.text

  try {
    const url = process.env.SHEET_CSV_URL
    if (!url) throw new Error('SHEET_CSV_URL not set')

    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`sheet fetch ${res.status}`)

    const csv = await res.text()
    const text = csvToFaqText(csv)

    cache = { text, expiresAt: now + CACHE_TTL_MS }
    return text
  } catch (err) {
    // Serve stale cache if fetch fails — bot stays up
    if (cache) {
      console.warn('[sheet] fetch failed · serving stale cache', err)
      return cache.text
    }
    throw err
  }
}

function csvToFaqText(csv: string): string {
  const rows = parseCsvRows(csv).slice(1) // skip header row
  // Sheet format: id, type, category, keywords, answer, url, brand, model_code, price, price_pack, license_required, license_ref
  return rows
    .map(([_id, _type, category, keywords, answer, url, brand, model_code, price]) => {
      if (!keywords || !answer) return null
      const cleanAnswer = answer.replace(/\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()

      // ข้อมูลสินค้า (ถ้ามี)
      const productParts = [brand, model_code].filter(Boolean)
      const productInfo = productParts.length ? ` [${productParts.join(' ')}]` : ''
      const priceInfo = price ? ` ราคา: ${price}` : ''
      const urlInfo = url ? ` ข้อมูลเพิ่มเติม: ${url}` : ''

      return `[${category}]${productInfo}${priceInfo} ${keywords}\n→ ${cleanAnswer}${urlInfo}`
    })
    .filter(Boolean)
    .join('\n\n')
}

// Proper CSV parser that handles quoted fields containing newlines
function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < csv.length) {
    const ch = csv[i]

    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        field += '"'
        i += 2
        continue
      }
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      row.push(field.trim())
      field = ''
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && csv[i + 1] === '\n') i++
      row.push(field.trim())
      if (row.some((f) => f)) rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
    i++
  }

  // flush last row
  row.push(field.trim())
  if (row.some((f) => f)) rows.push(row)

  return rows
}
