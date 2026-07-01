import { NextRequest } from 'next/server'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply } from '@/lib/gemini'
import { shouldHandoff } from '@/lib/handoff'
import { redis } from '@/lib/redis'
import { log } from '@/lib/log'
import { isScheduledOff } from '@/lib/schedule'

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
const RETRY_TTL       = 10 * 60

const CONTACT_MSG = 'ขออภัยค่ะ ไม่พบข้อมูลที่ตรงกับคำถาม 🙏\nสอบถามเพิ่มเติมได้ที่\n📱 LINE OA: @spenderclub\n🕐 เวลาทำการ 08:00–17:00 น. (จันทร์–ศุกร์) ค่ะ'

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
  if (/^(.)\1+$/u.test(msg)) return true  // aaa, ???, 555
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
        return json({ reply: 'รอสักครู่นะคะ น้องใจดีกำลังอ่านข้อความค่ะ 🙏' }, cors)
      }
    } catch { /* Redis ล่ม — ข้าม */ }

    // Nonsense filter — กรองก่อนส่ง Gemini
    if (isNonsenseMessage(message)) {
      return json({ reply: 'มีอะไรให้น้องใจดีช่วยไหมคะ 😊' }, cors)
    }

    // Schedule check
    if (await isScheduledOff('web')) {
      log.info('webchat.scheduled_off', { userId })
      return json({
        reply: 'ขณะนี้อยู่นอกเวลาทำการค่ะ น้องใจดีจะกลับมาให้บริการในเวลาทำการนะคะ 🙏\nหากต้องการติดต่อด่วน สามารถ inbox Facebook Spender Club ได้เลยค่ะ',
      }, cors)
    }

    const history = await getHistory(sessionId)
    const faqText = await fetchFAQ()

    // shouldHandoff — เว็บไม่มีแอดมิน real-time ให้บอกช่องทาง LINE แทน
    if (shouldHandoff(message)) {
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: CONTACT_MSG }])
      log.info('webchat.contact_redirect', { userId })
      return json({ reply: CONTACT_MSG }, cors)
    }

    // Gemini
    const reply = await Promise.race([
      generateReply(message, faqText, history, CONTACT_MSG),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
    ]).catch(() => GEMINI_UNAVAILABLE)

    if (reply === GEMINI_UNAVAILABLE) {
      return json({ reply: 'ขออภัยค่ะ ระบบกำลังประมวลผลนานกว่าปกติ กรุณาลองใหม่อีกครั้งนะคะ 🙏' }, cors)
    }

    if (reply === 'CANCEL_IMEI') {
      await saveHistory(sessionId, [])
      return json({ reply: 'ยกเลิกรายการแล้วค่ะ มีอะไรให้น้องใจดีช่วยอีกไหมคะ' }, cors)
    }

    if (reply === 'HANDOFF' || reply.toUpperCase().startsWith('HANDOFF')) {
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: CONTACT_MSG }])
      return json({ reply: CONTACT_MSG }, cors)
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
        return json({ reply: 'ขออภัยค่ะ น้องใจดีตอบได้เฉพาะเรื่องวิทยุสื่อสารนะคะ 🙏' }, cors)
      }
      if (count <= 1) {
        const msg = 'น้องใจดีเป็นผู้ช่วยด้านวิทยุสื่อสารเท่านั้นค่ะ มีอะไรให้ช่วยเรื่องวิทยุสื่อสารไหมคะ'
        await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: msg }])
        return json({ reply: msg }, cors)
      }
      return json({ reply: '' }, cors) // เงียบครั้งที่ 2–4
    }

    // NOT_FOUND
    if (reply === NOT_FOUND) {
      try {
        const hasRetried = await redis.get(`webchat:retry:${sessionId}`)
        if (hasRetried) {
          await redis.del(`webchat:retry:${sessionId}`)
          await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: CONTACT_MSG }])
          return json({ reply: CONTACT_MSG }, cors)
        } else {
          await redis.set(`webchat:retry:${sessionId}`, '1', { ex: RETRY_TTL })
          try {
            await redis.lpush('unanswered_log', JSON.stringify({ ts: new Date().toISOString(), userId, question: message }))
            await redis.ltrim('unanswered_log', 0, 499)
          } catch { /* */ }
          const retryMsg = 'ขออภัยค่ะ ไม่พบข้อมูลในระบบ ลองอธิบายเพิ่มเติมได้เลยนะคะ'
          await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: retryMsg }])
          return json({ reply: retryMsg }, cors)
        }
      } catch {
        return json({ reply: 'ขออภัยค่ะ ไม่พบข้อมูล กรุณาลองอีกครั้งนะคะ' }, cors)
      }
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
          return json({ reply: reminder }, cors)
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
    return json({ reply }, cors)

  } catch (err) {
    log.error('webchat.error', { err: (err as Error).message, userId })
    return json({ reply: 'ขออภัยค่ะ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งนะคะ' }, cors)
  }
}
