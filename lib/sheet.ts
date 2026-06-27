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
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) throw new Error(`sheet fetch ${res.status}`)

    const csv = await res.text()
    const text = csvToFaqText(csv)

    cache = { text, expiresAt: now + CACHE_TTL_MS }
    return text
  } catch (err) {
    if (cache) {
      console.warn('[sheet] fetch failed · serving stale cache', err)
      return cache.text
    }
    throw err
  }
}

// --- Types ---
type Row = {
  id: string
  type: string
  category: string
  keywords: string
  answer: string
  url: string
  brand: string
  model_code: string
  price: string
  price_pack: string
  stock: string
  license_required: string
  license_ref: string
}

type LicenseInfo = { answer: string; url: string }

// --- Main parser ---
function csvToFaqText(csv: string): string {
  const rawRows = parseCsvRows(csv).slice(1) // skip header

  const rows: Row[] = rawRows.map((cols) => ({
    id:               cols[0]  ?? '',
    type:             cols[1]  ?? '',
    category:         cols[2]  ?? '',
    keywords:         cols[3]  ?? '',
    answer:           cols[4]  ?? '',
    url:              cols[5]  ?? '',
    brand:            cols[6]  ?? '',
    model_code:       cols[7]  ?? '',
    price:            cols[8]  ?? '',
    price_pack:       cols[9]  ?? '',
    stock:            cols[10] ?? '',
    license_required: cols[11] ?? '',
    license_ref:      cols[12] ?? '',
  }))

  // Build license lookup: id → {answer, url}
  const licenseMap = new Map<string, LicenseInfo>()
  for (const r of rows) {
    if (r.type === 'license' && r.id) {
      licenseMap.set(r.id, {
        answer: clean(r.answer),
        url: r.url,
      })
    }
  }

  return rows
    .map((row) => {
      if (!row.keywords || !row.answer) return null

      if (row.type === 'product') return formatProduct(row, licenseMap)
      if (row.type === 'faq') return formatFaq(row)
      if (row.type === 'license') return formatLicense(row)
      return null
    })
    .filter(Boolean)
    .join('\n\n')
}

// --- Format License row ---
function formatLicense(row: Row): string {
  const urlInfo = row.url ? ` ดูขั้นตอน: ${row.url}` : ''
  return `[ใบอนุญาต] ${row.keywords}\n→ ${clean(row.answer)}${urlInfo}`
}

// --- Format FAQ row ---
function formatFaq(row: Row): string {
  const urlInfo = row.url ? ` ข้อมูลเพิ่มเติม: ${row.url}` : ''
  return `[${row.category}] ${row.keywords}\n→ ${clean(row.answer)}${urlInfo}`
}

// --- Format Product row ---
function formatProduct(row: Row, licenseMap: Map<string, LicenseInfo>): string {
  const name = `${row.brand} ${row.model_code}`.trim()

  // Out of stock
  if (row.stock === 'out') {
    const fallbackUrl = row.url || 'https://www.spenderclub.com'
    return `[สินค้า] ${name} | ${row.keywords}
→ [OUT_OF_STOCK] ${name} ตอนนี้ของหมดชั่วคราวค่ะ 🙏
  รบกวนสอบถามคิวสินค้าเข้ากับแอดมิน หรือดูรุ่นใกล้เคียงได้ที่ ${fallbackUrl}`
  }

  // Price
  let priceText = ''
  const hasPrice = row.price && row.price !== '-'
  const hasPack  = row.price_pack && row.price_pack !== '-'

  if (hasPrice && hasPack) {
    priceText = `ราคา ${row.price} บาท หรือ ${row.price_pack} (โปรโมชั่นสุดคุ้ม)`
  } else if (hasPrice) {
    priceText = `ราคา ${row.price} บาท`
  } else if (hasPack) {
    priceText = row.price_pack
  }

  // License
  let licenseText = ''
  if (row.license_required === 'ไม่ต้องขอ') {
    licenseText = 'ไม่ต้องขอใบอนุญาต ใช้ได้ถูกกฎหมาย'
  } else if (row.license_required === 'ต้องขอ') {
    const licInfo = row.license_ref ? licenseMap.get(row.license_ref) : undefined
    if (licInfo) {
      licenseText = `ถูกกฎหมาย (รุ่นนี้ต้องทำใบอนุญาต — ${licInfo.answer}${licInfo.url ? ' ดูขั้นตอน: ' + licInfo.url : ''})`
    } else {
      licenseText = 'ถูกกฎหมาย (รุ่นนี้ต้องทำใบอนุญาต สอบถามรายละเอียดได้ค่ะ)'
    }
  }

  const urlLine = row.url ? `ดูรายละเอียด/ราคาล่าสุด: ${row.url}` : ''

  return `[สินค้า] ${name} | ${row.category} | ${row.keywords}
→ PRICE: ${priceText || 'สอบถามราคากับแอดมินได้เลยค่ะ'}
  INFO: ${clean(row.answer)}
  LICENSE: ${licenseText || '-'} รับประกัน 2 ปี
  ${urlLine}
  CTA: ลูกค้าสนใจสั่งเลยไหมคะ?`
}

function clean(text: string): string {
  return text.replace(/\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

// --- CSV parser (handles quoted fields with newlines) ---
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

  row.push(field.trim())
  if (row.some((f) => f)) rows.push(row)

  return rows
}
