import { NextRequest } from 'next/server'
import { fetchFAQ, findExactMatch } from '@/lib/sheet'
import { generateReply } from '@/lib/gemini'
import { shouldHandoff } from '@/lib/handoff'
import { redis } from '@/lib/redis'
import { log } from '@/lib/log'
import { isScheduledOff } from '@/lib/schedule'
import { logChat } from '@/lib/chatlog'

export const runtime = 'nodejs'
export const maxDuration = 30

const NOT_FOUND          = '[NOT_FOUND]'
const OUT_OF_DOMAIN      = '[OUT_OF_DOMAIN]'
const GEMINI_UNAVAILABLE = '[GEMINI_UNAVAILABLE]'

const SESSION_TTL     = 30 * 60
const RATE_TTL        = 10
const RATE_LIMIT      = 5
const NONSENSE_TTL    = 10 * 60
const LAST_ANSWER_TTL = 2 * 60

// fallback ทุกกรณีที่ Web Chat ตอบไม่ได้
const FALLBACK_MSG = 'รบกวนสอบถามรายละเอียดเพิ่มเติมได้ที่\nแอดไลน์ @spenderclub\nเบอร์โทรติดต่อ: 085-222-9111, 089-661-2682\nจันทร์–เสาร์ เวลา 08:00–17:00 น.ค่ะ'

const ORDER_RE = /อยากสั่ง|ต้องการซื้อ|จะซื้อ|สั่งได้ไหม|ซื้อยังไง|โอนเงิน|ชำระเงิน|จ่ายเงิน/u

// Contact suffix — ข้อความเดียวใช้ทั้ง 2 กรณี: ต่อท้ายข้อความแรกของ session (ไม่มีราคา)
// และต่อท้ายทุกครั้งที่คำตอบมีราคา (บาท) — ดู withSuffix()
// (ไม่ต่อท้าย FALLBACK_MSG เพราะมีเบอร์ติดต่อฝังอยู่แล้ว)
const CONTACT_SUFFIX    = '\n\nสอบถามรายละเอียดเพิ่มเติมติดต่อได้ที่\nแอดไลน์ @spenderclub\nเบอร์โทรติดต่อ: 085-222-9111, 089-661-2682\nจันทร์–เสาร์ เวลา 08:00–17:00 น.ค่ะ'
const CONTACT_SHOWN_TTL = SESSION_TTL

// Anti-spam
const IP_RATE_LIMIT       = 20
const IP_RATE_TTL         = 5 * 60   // 5 นาที
const BLOCKED_TTL         = 30 * 60  // 30 นาที
const OOD_BLOCK_THRESHOLD = 5

const ALLOWED_ORIGINS = [
  'https://www.spenderclub.com',
  'https://spenderclub.com',
  'http://localhost:3000',
]

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

function json(data: unknown, cors: Record<string, string>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

function isNonsenseMessage(msg: string): boolean {
  if (msg.length < 2) return true
  if (/^(.)\1+$/u.test(msg)) return true   // ตัวอักษรซ้ำทั้งหมด: aaa, ???, 555
  if (/(.)\1{2,}/u.test(msg)) return true  // ตัวอักษรซ้ำ 3+ ติดกัน: ดดด, ไไไไ, !!!
  return false
}

type History = { role: 'user' | 'model'; text: string }[]

async function getHistory(sid: string): Promise<History> {
  try { return (await redis.get<History>(`webchat:hist:${sid}`)) ?? [] }
  catch { return [] }
}

async function saveHistory(sid: string, history: History) {
  try { await redis.set(`webchat:hist:${sid}`, history.slice(-20), { ex: SESSION_TTL }) }
  catch { /* Redis ล่ม */ }
}

// ต่อท้าย CONTACT_SUFFIX เฉพาะข้อความแรกที่บอทตอบใน session (เช็คผ่าน redis flag ต่อ sessionId)
async function withContactSuffix(sid: string, replyText: string): Promise<string> {
  if (!replyText) return replyText
  try {
    const shown = await redis.get(`webchat:contact_shown:${sid}`)
    if (shown) return replyText
    await redis.set(`webchat:contact_shown:${sid}`, '1', { ex: CONTACT_SHOWN_TTL })
    return replyText + CONTACT_SUFFIX
  } catch {
    return replyText // Redis ล่ม — ส่งข้อความปกติโดยไม่ต่อท้าย
  }
}

// ถ้าคำตอบมีราคา (บาท) → ต่อ CONTACT_SUFFIX ทุกครั้ง (ชวนติดต่อซ้ำได้ทุกครั้งที่บอกราคา ไม่จำกัดแค่ครั้งแรก)
// พร้อม mark ว่าโชว์เบอร์ติดต่อไปแล้ว กันต่อซ้อนกันในข้อความเดียวกันตอนเป็นข้อความแรกของ session ด้วย
// ถ้าไม่มีราคา → ใช้ withContactSuffix ตามปกติ (โชว์แค่ครั้งแรกของ session)
async function withSuffix(sid: string, replyText: string): Promise<string> {
  if (!replyText) return replyText
  if (replyText.includes('บาท')) {
    try { await redis.set(`webchat:contact_shown:${sid}`, '1', { ex: CONTACT_SHOWN_TTL }) } catch { /* Redis ล่ม */ }
    return replyText + CONTACT_SUFFIX
  }
  return withContactSuffix(sid, replyText)
}

// OPTIONS — CORS preflight
export async function OPTIONS(req: NextRequest) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  })
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get('origin'))

  let sessionId: string, message: string, hp: string
  try {
    const body = await req.json() as { sessionId?: string; message?: string; _hp?: string }
    sessionId = (body.sessionId ?? '').trim()
    message   = (body.message ?? '').trim()
    hp        = body._hp ?? ''
  } catch {
    return json({ error: 'invalid body' }, cors, 400)
  }
  if (!sessionId || !message) return json({ error: 'missing fields' }, cors, 400)

  // Honeypot — bot อัตโนมัติจะกรอก field นี้ เงียบเลย
  if (hp !== '') return json({ reply: '' }, cors)

  const userId    = `web:${sessionId}`
  const startTime = Date.now()

  try {
    // IP rate limit — 20 ข้อความต่อ 5 นาที
    const ip = getClientIp(req)
    try {
      const [ipCount] = await redis.pipeline()
        .incr(`web_ip_rate:${ip}`)
        .expire(`web_ip_rate:${ip}`, IP_RATE_TTL)
        .exec() as [number, number]
      if (ipCount > IP_RATE_LIMIT) {
        return json({ reply: 'ขออภัยค่ะ ส่งข้อความถี่เกินไปนิดนึง รบกวนรอ 5 นาทีแล้วถามใหม่อีกครั้งนะคะ 🙏' }, cors)
      }
    } catch { /* Redis ล่ม — ข้าม */ }

    // Session blocked — OOD เกิน threshold
    try {
      const blocked = await redis.get(`web_blocked:${sessionId}`)
      if (blocked) return json({ reply: '' }, cors)
    } catch { /* */ }

    // Session rate limit
    try {
      const [rate] = await redis.pipeline()
        .incr(`webchat:rate:${sessionId}`)
        .expire(`webchat:rate:${sessionId}`, RATE_TTL)
        .exec() as [number, number]
      if (rate > RATE_LIMIT) {
        return json({ reply: FALLBACK_MSG }, cors)
      }
    } catch { /* Redis ล่ม — ข้าม */ }

    // Nonsense filter — กรองก่อนส่ง Gemini
    if (isNonsenseMessage(message)) {
      return json({ reply: await withContactSuffix(sessionId, 'มีอะไรให้น้องใจดีช่วยไหมคะ 😊') }, cors)
    }

    // Schedule check
    if (await isScheduledOff('web')) {
      log.info('webchat.scheduled_off', { userId })
      return json({
        reply: await withContactSuffix(sessionId, 'ขณะนี้อยู่นอกเวลาทำการค่ะ น้องใจดีจะกลับมาให้บริการในเวลาทำการนะคะ 🙏\nหากต้องการติดต่อด่วน สามารถ inbox Facebook Spender Club ได้เลยค่ะ'),
      }, cors)
    }

    const history = await getHistory(sessionId)
    logChat({ userId, channel: 'Web', role: 'user', message, ts: Date.now() })
    const faqText = await fetchFAQ()

    // shouldHandoff — เว็บไม่มีแอดมิน real-time ตอบครั้งแรกเท่านั้น ครั้งต่อไปเงียบ
    if (shouldHandoff(message)) {
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: FALLBACK_MSG }])
      log.info('webchat.handoff', { userId })
      return json({ reply: FALLBACK_MSG }, cors)
    }

    // Exact keyword match — คำถามง่าย/ชัดเจนตรงกับชีต ตอบทันทีไม่ผ่าน Gemini
    const exactMatch = await findExactMatch(message)
    if (exactMatch) {
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: exactMatch }])
      log.info('webchat.exact_match', { userId })
      return json({ reply: await withSuffix(sessionId, exactMatch) }, cors)
    }

    // Case 2: ลูกค้าแสดงเจตนาสั่งซื้อชัดเจน → ตอบทันที ไม่ผ่าน Gemini
    if (ORDER_RE.test(message)) {
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: FALLBACK_MSG }])
      log.info('webchat.order_intent', { userId })
      return json({ reply: FALLBACK_MSG }, cors)
    }

    // Gemini
    const reply = await Promise.race([
      generateReply(message, faqText, history, FALLBACK_MSG),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
    ]).catch(() => GEMINI_UNAVAILABLE)

    if (reply === GEMINI_UNAVAILABLE) {
      return json({ reply: FALLBACK_MSG }, cors)
    }

    if (reply === 'CANCEL_IMEI') {
      await saveHistory(sessionId, [])
      return json({ reply: await withContactSuffix(sessionId, 'ยกเลิกรายการแล้วค่ะ มีอะไรให้น้องใจดีช่วยอีกไหมคะ') }, cors)
    }

    if (reply === 'HANDOFF' || reply.toUpperCase().startsWith('HANDOFF')) {
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: FALLBACK_MSG }])
      return json({ reply: FALLBACK_MSG }, cors)
    }

    // Out of domain
    if (reply === OUT_OF_DOMAIN || reply.startsWith(OUT_OF_DOMAIN)) {
      let count = 0
      try {
        const [c] = await redis.pipeline()
          .incr(`webchat:nonsense:${sessionId}`)
          .expire(`webchat:nonsense:${sessionId}`, NONSENSE_TTL)
          .exec() as [number, number]
        count = c
      } catch { /* */ }
      if (count >= OOD_BLOCK_THRESHOLD) {
        try { await redis.set(`web_blocked:${sessionId}`, '1', { ex: BLOCKED_TTL }) } catch { /* */ }
        return json({ reply: await withContactSuffix(sessionId, 'ขออภัยค่ะ น้องใจดีตอบได้เฉพาะเรื่องวิทยุสื่อสารนะคะ 🙏') }, cors)
      }
      if (count <= 1) {
        const msg = 'น้องใจดีเป็นผู้ช่วยด้านวิทยุสื่อสารเท่านั้นค่ะ มีอะไรให้ช่วยเรื่องวิทยุสื่อสารไหมคะ'
        await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: msg }])
        return json({ reply: await withContactSuffix(sessionId, msg) }, cors)
      }
      return json({ reply: '' }, cors) // เงียบครั้งที่ 2–4
    }

    // NOT_FOUND
    if (reply === NOT_FOUND) {
      try {
        await redis.lpush('unanswered_log', JSON.stringify({ ts: new Date().toISOString(), userId, question: message }))
        await redis.ltrim('unanswered_log', 0, 499)
      } catch { /* */ }
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: FALLBACK_MSG }])
      return json({ reply: FALLBACK_MSG }, cors)
    }

    // Duplicate suppression
    try {
      const last = await redis.get<string>(`webchat:last_answer:${sessionId}`)
      if (last && last === reply) {
        const [cnt] = await redis.pipeline()
          .incr(`webchat:repeat:${sessionId}`)
          .expire(`webchat:repeat:${sessionId}`, LAST_ANSWER_TTL)
          .exec() as [number, number]
        if (cnt === 1) {
          const reminder = 'ข้อมูลเดิมตามที่แจ้งไปนะคะ มีอะไรให้น้องใจดีช่วยเพิ่มเติมไหมคะ 😊'
          await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: reminder }])
          return json({ reply: await withContactSuffix(sessionId, reminder) }, cors)
        }
        return json({ reply: '' }, cors)
      }
      await redis.set(`webchat:last_answer:${sessionId}`, reply, { ex: LAST_ANSWER_TTL })
      await redis.del(`webchat:repeat:${sessionId}`)
    } catch { /* Redis ล่ม — ส่งปกติ */ }

    // Track frequency
    try { await redis.zincrby('question_freq', 1, message.slice(0, 100)) } catch { /* */ }

    await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: reply }])
    log.info('webchat.reply.sent', { userId, latencyMs: Date.now() - startTime, replyLength: reply.length })
    logChat({ userId, channel: 'Web', role: 'bot', message: reply, ts: Date.now() })
    return json({ reply: await withSuffix(sessionId, reply) }, cors)

  } catch (err) {
    log.error('webchat.error', { err: (err as Error).message, userId })
    return json({ reply: 'ขออภัยค่ะ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งนะคะ' }, cors)
  }
}
