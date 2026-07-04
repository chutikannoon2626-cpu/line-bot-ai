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
  license_required: string
  license_ref: string
}

type LicenseInfo = { answer: string; url: string }
type Sheet = { text: string; rows: Row[]; licenseMap: Map<string, LicenseInfo>; expiresAt: number }

let cache: Sheet | null = null
const CACHE_TTL_MS = 60_000

async function loadSheet(): Promise<Sheet> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache

  try {
    const url = process.env.SHEET_CSV_URL
    if (!url) throw new Error('SHEET_CSV_URL not set')

    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) throw new Error(`sheet fetch ${res.status}`)

    const csv = await res.text()
    const rows = parseRows(csv)
    const licenseMap = buildLicenseMap(rows)
    const text = rowsToFaqText(rows, licenseMap)

    cache = { text, rows, licenseMap, expiresAt: now + CACHE_TTL_MS }
    return cache
  } catch (err) {
    if (cache) {
      console.warn('[sheet] fetch failed · serving stale cache', err)
      return cache
    }
    throw err
  }
}

export async function fetchFAQ(): Promise<string> {
  const sheet = await loadSheet()
  return sheet.text
}

// --- Exact keyword match — ทางลัดก่อน Gemini เฉพาะคำถามง่ายและชัดเจนจริงๆ เท่านั้น ---
// กันเข้าใจผิดบริบท: ต้องผ่านทั้ง 2 ชั้น (สั้น+ตรง keyword และ ไม่มีคำที่บ่งบอกความต้องการอื่น)
const BLOCK_INTENT_RE = /เสีย|ซ่อม|พัง|ปัญหา|เคลม|ต่างกัน|เปรียบเทียบ|ดีกว่า|ไม่เอา|ไม่ใช่|ยกเลิก|แนะนำ|งบ|เหมาะกับ/u
const MAX_EXTRA_CHARS = 15 // ข้อความยาวกว่า keyword ที่ match ได้ไม่เกินกี่ตัวอักษร ถึงจะถือว่า "คำถามง่าย"

export async function findExactMatch(userMessage: string): Promise<string | null> {
  const msg = userMessage.trim().toLowerCase()
  if (!msg || msg.length > 40) return null   // ยาวเกินไป ไม่ใช่คำถามง่าย
  if (BLOCK_INTENT_RE.test(msg)) return null  // มีคำที่บ่งบอกความต้องการอื่น (ซ่อม/เปรียบเทียบ/ปฏิเสธ/แนะนำ ฯลฯ)

  try {
    const { rows, licenseMap } = await loadSheet()

    const matches = rows.filter((row) => {
      if (!row.keywords || !row.answer) return false
      const keywords = row.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
      return keywords.some((k) => msg.includes(k) && msg.length <= k.length + MAX_EXTRA_CHARS)
    })

    if (matches.length !== 1) return null // ไม่เจอ หรือเจอหลายรุ่น (กำกวม) → ปล่อยให้ Gemini จัดการ

    const row = matches[0]
    if (row.type === 'product') return formatProduct(row, licenseMap)
    if (row.type === 'faq')     return formatFaq(row)
    if (row.type === 'license') return formatLicense(row)
  } catch { /* sheet โหลดไม่ได้ — ปล่อยผ่านไป Gemini ตามปกติ */ }

  return null
}

// --- Parse CSV rows into structured Row[] ---
function parseRows(csv: string): Row[] {
  const rawRows = parseCsvRows(csv).slice(1) // skip header
  return rawRows.map((cols) => ({
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
    license_required: cols[10] ?? '',
    license_ref:      cols[11] ?? '',
  }))
}

// --- Build license lookup: id → {answer, url} ---
function buildLicenseMap(rows: Row[]): Map<string, LicenseInfo> {
  const licenseMap = new Map<string, LicenseInfo>()
  for (const r of rows) {
    if (r.type === 'license' && r.id) {
      licenseMap.set(r.id, { answer: clean(r.answer), url: r.url })
    }
  }
  return licenseMap
}

// --- Build full FAQ text (embedded into Gemini prompt) ---
function rowsToFaqText(rows: Row[], licenseMap: Map<string, LicenseInfo>): string {
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
