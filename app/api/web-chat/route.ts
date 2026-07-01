import { NextRequest } from 'next/server'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply } from '@/lib/gemini'
import { shouldHandoff, notifyAdmin } from '@/lib/handoff'
import { redis } from '@/lib/redis'
import { log } from '@/lib/log'
import { isScheduledOff } from '@/lib/schedule'

export const runtime = 'nodejs'
export const maxDuration = 30

const NOT_FOUND        = '[NOT_FOUND]'
const OUT_OF_DOMAIN    = '[OUT_OF_DOMAIN]'
const GEMINI_UNAVAILABLE = '[GEMINI_UNAVAILABLE]'

const SESSION_TTL    = 30 * 60   // 30 นาที
const RATE_TTL       = 10        // วินาที
const RATE_LIMIT     = 5
const NONSENSE_TTL   = 10 * 60
const LAST_ANSWER_TTL = 2 * 60
const RETRY_TTL      = 10 * 60

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

  let sessionId: string, message: string
  try {
    const body = await req.json() as { sessionId?: string; message?: string }
    sessionId = (body.sessionId ?? '').trim()
    message   = (body.message ?? '').trim()
  } catch {
    return json({ error: 'invalid body' }, cors, 400)
  }
  if (!sessionId || !message) return json({ error: 'missing fields' }, cors, 400)

  const userId    = `web:${sessionId}`
  const startTime = Date.now()

  try {
    // Rate limit
    try {
      const [rate] = await redis.pipeline()
        .incr(`webchat:rate:${sessionId}`)
        .expire(`webchat:rate:${sessionId}`, RATE_TTL)
        .exec() as [number, number]
      if (rate > RATE_LIMIT) {
        return json({ reply: 'รอสักครู่นะคะ น้องใจดีกำลังอ่านข้อความค่ะ 🙏' }, cors)
      }
    } catch { /* Redis ล่ม — ข้าม */ }

    // Schedule check — ถ้าปิดบอท แจ้งลูกค้า (ไม่ใช่แค่เงียบ เพราะไม่มีแอดมินดูแลเว็บ)
    if (await isScheduledOff('web')) {
      log.info('webchat.scheduled_off', { userId })
      return json({
        reply: 'ขณะนี้อยู่นอกเวลาทำการค่ะ น้องใจดีจะกลับมาให้บริการในเวลาทำการนะคะ 🙏\nหากต้องการติดต่อด่วน สามารถ inbox Facebook Spender Club ได้เลยค่ะ',
      }, cors)
    }

    const history = await getHistory(sessionId)
    const faqText = await fetchFAQ()
    const handoffMsg = 'หากต้องการติดต่อแอดมิน กรุณาแจ้งน้องใจดีได้เลยค่ะ'

    // Pre-handoff: รอข้อมูลติดต่อจากลูกค้า
    let waitingContact = false
    try { waitingContact = !!(await redis.get(`webchat:pending_contact:${sessionId}`)) }
    catch { /* Redis ล่ม */ }

    if (waitingContact) {
      try { await redis.del(`webchat:pending_contact:${sessionId}`) } catch { /* */ }
      const contactInfo = message
      try {
        await notifyAdmin(
          `web:${sessionId.slice(-8)}`,
          `[ลูกค้าเว็บไซต์ spenderclub.com]\nขอให้ติดต่อกลับที่: ${contactInfo}`
        )
      } catch (err) {
        log.error('webchat.handoff.notify_failed', { err: (err as Error).message })
      }
      const confirmMsg = 'ได้รับข้อมูลแล้วค่ะ แอดมินจะติดต่อกลับเร็วๆ นี้นะคะ 🙏 ขอบคุณค่ะ'
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: confirmMsg }])
      log.info('webchat.handoff.contact_received', { userId, latencyMs: Date.now() - startTime })
      return json({ reply: confirmMsg }, cors)
    }

    // shouldHandoff — ลูกค้าแจ้งความต้องการให้แอดมิน
    if (shouldHandoff(message)) {
      try { await redis.set(`webchat:pending_contact:${sessionId}`, '1', { ex: SESSION_TTL }) } catch { /* */ }
      const askMsg = 'น้องใจดีจะแจ้งแอดมินให้ติดต่อกลับค่ะ 😊\nขอเบอร์โทรศัพท์หรือ LINE ID ของลูกค้าได้เลยนะคะ'
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: askMsg }])
      log.info('webchat.handoff.ask_contact', { userId })
      return json({ reply: askMsg }, cors)
    }

    // Gemini
    const reply = await Promise.race([
      generateReply(message, faqText, history, handoffMsg),
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
      try { await redis.set(`webchat:pending_contact:${sessionId}`, '1', { ex: SESSION_TTL }) } catch { /* */ }
      const askMsg = 'น้องใจดีจะแจ้งแอดมินให้ติดต่อกลับค่ะ 😊\nขอเบอร์โทรศัพท์หรือ LINE ID ของลูกค้าได้เลยนะคะ'
      await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: askMsg }])
      return json({ reply: askMsg }, cors)
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
      if (count <= 1) {
        const msg = 'น้องใจดีเป็นผู้ช่วยด้านวิทยุสื่อสารเท่านั้นค่ะ มีอะไรให้ช่วยเรื่องวิทยุสื่อสารไหมคะ'
        await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: msg }])
        return json({ reply: msg }, cors)
      }
      return json({ reply: '' }, cors) // เงียบครั้งที่ 2+
    }

    // NOT_FOUND
    if (reply === NOT_FOUND) {
      try {
        const hasRetried = await redis.get(`webchat:retry:${sessionId}`)
        if (hasRetried) {
          await redis.del(`webchat:retry:${sessionId}`)
          try { await redis.set(`webchat:pending_contact:${sessionId}`, '1', { ex: SESSION_TTL }) } catch { /* */ }
          const askMsg = 'ขออภัยค่ะ ไม่พบข้อมูลในระบบ น้องใจดีจะแจ้งแอดมินให้ติดต่อกลับค่ะ\nขอเบอร์โทรหรือ LINE ID ได้เลยนะคะ'
          await saveHistory(sessionId, [...history, { role: 'user', text: message }, { role: 'model', text: askMsg }])
          return json({ reply: askMsg }, cors)
        } else {
          await redis.set(`webchat:retry:${sessionId}`, '1', { ex: RETRY_TTL })
          try {
            await redis.lpush('unanswered_log', JSON.stringify({ ts: new Date().toISOString(), userId, question: message }))
            await redis.ltrim('unanswered_log', 0, 499)
          } catch { /* */ }
          const retryMsg = 'ขออภัยค่ะ ไม่พบข้อมูลในระบบ ลองอธิบายเพิ่มเติมได้เลยนะคะ หรือต้องการให้แอดมินช่วยดูแลคะ'
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
