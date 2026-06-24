import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply } from '@/lib/gemini'
import { shouldHandoff } from '@/lib/handoff'
import { redis } from '@/lib/redis'
import { getHistory, saveHistory } from '@/lib/history'
import { log } from '@/lib/log'

export const runtime = 'nodejs'
export const maxDuration = 30

const NOT_FOUND = '[NOT_FOUND]'
const OUT_OF_DOMAIN = '[OUT_OF_DOMAIN]'
const OUT_OF_DOMAIN_MSG = 'น้องใจดีเป็นผู้ช่วยด้านวิทยุสื่อสารเท่านั้นค่ะ ต้องการสอบถามข้อมูลวิทยุสื่อสารรุ่นไหนคะ'
const DEFAULT_REPLY = 'ขออภัยค่ะ น้องใจดีไม่พบข้อมูล ต้องการติดต่อแอดมินแจ้งได้เลยนะคะ'
const PRE_HANDOFF_TTL = 600
const RETRY_TTL = 600
const OFF_HOURS_TTL = 23 * 3600
const IN_HOURS_TTL = 23 * 3600
const OUT_OF_DOMAIN_TTL = 24 * 3600

const OFF_HOURS_NOTICE = 'ขณะนี้อยู่นอกเวลาทำการ โดยแอดมินจะตอบกลับในช่วงเวลาทำการ 08:00–17:00 น. ค่ะ🙏 ให้น้องใจดีช่วยดูแลนะคะ'

function getHandoffMessage(): string {
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  return thaiHour >= 18 || thaiHour < 8
    ? 'ขณะนี้อยู่นอกเวลาทำการ รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานให้บริการในเวลาทำการ 08:00–17:00 น. ค่ะ'
    : 'รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานกำลังดูแลท่านอยู่ค่ะ'
}

// ส่งข้อความ text ผ่าน Facebook Send API
async function fbSend(psid: string, text: string) {
  await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, message: { text } }),
      signal: AbortSignal.timeout(5000),
    }
  ).catch(err => log.error('fb.send_failed', { psid, err: (err as Error).message }))
}

// ส่ง Quick Replies
async function fbSendQuickReplies(
  psid: string,
  text: string,
  buttons: { title: string; payload: string }[]
) {
  await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        message: {
          text,
          quick_replies: buttons.map(b => ({
            content_type: 'text',
            title: b.title,
            payload: b.payload,
          })),
        },
      }),
      signal: AbortSignal.timeout(5000),
    }
  ).catch(err => log.error('fb.quickreply_failed', { psid, err: (err as Error).message }))
}

// ตรวจ Facebook signature
function verifySignature(rawBody: string, sig: string | null): boolean {
  const secret = process.env.FACEBOOK_APP_SECRET
  if (!sig || !secret) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  } catch {
    return false
  }
}

// GET — Facebook webhook verification
export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams
  if (
    p.get('hub.mode') === 'subscribe' &&
    p.get('hub.verify_token') === process.env.FACEBOOK_VERIFY_TOKEN
  ) {
    log.info('fb.webhook_verified')
    return new Response(p.get('hub.challenge') ?? '', { status: 200 })
  }
  return new Response('Forbidden', { status: 403 })
}

type FbEvent = {
  sender: { id: string }
  message?: {
    text?: string
    attachments?: Array<{ type: string; payload: { url?: string } }>
  }
  postback?: { payload: string; title: string }
}

// POST — Incoming messages
export async function POST(req: NextRequest) {
  const rawBody = await req.text()

  if (!verifySignature(rawBody, req.headers.get('x-hub-signature-256'))) {
    log.warn('fb.invalid_signature')
    return new Response('Invalid signature', { status: 401 })
  }

  const body = JSON.parse(rawBody) as {
    object: string
    entry: Array<{ messaging: FbEvent[] }>
  }

  if (body.object !== 'page') return NextResponse.json({ ok: true })

  await Promise.all(
    body.entry.flatMap(entry =>
      entry.messaging.map(async (event) => {
        const psid = event.sender.id
        const userId = `fb:${psid}` // prefix แยก namespace จาก LINE
        const startTime = Date.now()

        try {
          // --- SESSION GREETING / OFF-HOURS NOTICE ---
          let offHoursNotice = false
          let showGreeting = false
          const thaiHour = (new Date().getUTCHours() + 7) % 24

          if (thaiHour >= 18 || thaiHour < 8) {
            try {
              const notified = await redis.get(`off_hours:${userId}`)
              if (!notified) {
                await redis.set(`off_hours:${userId}`, '1', { ex: OFF_HOURS_TTL })
                offHoursNotice = true
              }
            } catch { /* Redis ล่ม */ }
          } else {
            try {
              const greeted = await redis.get(`in_hours:${userId}`)
              if (!greeted) {
                await redis.set(`in_hours:${userId}`, '1', { ex: IN_HOURS_TTL })
                showGreeting = true
              }
            } catch { /* Redis ล่ม */ }
          }

          // --- TEXT ---
          if (event.message?.text) {
            const userMessage = event.message.text
            const history = await getHistory(userId)
            const handoffMsg = getHandoffMessage()

            // Off-hours notice (ส่งก่อน reply)
            if (offHoursNotice) await fbSend(psid, OFF_HOURS_NOTICE)

            // Greeting card → Quick replies
            if (showGreeting) {
              await fbSendQuickReplies(
                psid,
                'Spenderclub ยินดีให้บริการค่ะ มีอะไรให้น้องใจดีช่วยคะ หรือสามารถกดปุ่มเพื่อสอบถามได้เลยค่ะ',
                [
                  { title: 'สอบถาม Spendernetwork', payload: 'QUERY_SPENDERNETWORK' },
                  { title: 'วิทยุสื่อสาร/ราคา', payload: 'QUERY_RADIO' },
                  { title: 'แจ้งปัญหาการใช้งาน', payload: 'REPORT_ISSUE' },
                ]
              )
            }

            // Pre-handoff state
            let pendingTrigger: string | null = null
            try {
              pendingTrigger = await redis.getdel<string>(`pre_handoff:${userId}`)
            } catch { /* Redis ล่ม */ }

            if (pendingTrigger !== null) {
              const lastBot = [...history].reverse().find(t => t.role === 'model')
              if (!lastBot?.text?.includes('กรุณาแจ้งรายละเอียด')) {
                log.info('fb.handoff.stale_key_ignored', { userId })
                pendingTrigger = null
              }
            }

            if (pendingTrigger !== null) {
              try {
                await redis.set(`routed:${userId}`, '1', { ex: 300 })
              } catch { /* Redis ล่ม */ }
              await fbSend(psid, handoffMsg)
              await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
              log.info('fb.handoff.after_pre_handoff', { userId, latencyMs: Date.now() - startTime })
              return
            }

            if (shouldHandoff(userMessage)) {
              let alreadyRouted = false
              try { alreadyRouted = !!(await redis.get(`routed:${userId}`)) } catch { /* */ }

              if (alreadyRouted) {
                await fbSend(psid, 'ได้ส่งเรื่องถึงแอดมินแล้วค่ะ รอแอดมินติดต่อกลับด้วยนะคะ 🙏')
                return
              }

              try {
                await redis.set(`pre_handoff:${userId}`, userMessage, { ex: PRE_HANDOFF_TTL })
              } catch { log.warn('fb.handoff.save_failed', { userId }) }

              const preHandoffQ = 'กรุณาแจ้งรายละเอียดที่ต้องการให้แอดมินช่วยด้วยนะคะ เพื่อให้ดูแลได้ถูกต้องค่ะ'
              await fbSend(psid, preHandoffQ)
              await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: preHandoffQ }])
              log.info('fb.handoff.pre_handoff_question', { userId, latencyMs: Date.now() - startTime })
              return
            }

            const faqText = await fetchFAQ()
            const reply = await Promise.race([
              generateReply(userMessage, faqText, history, handoffMsg),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('gemini_timeout')), 12000)
              ),
            ]).catch(() => DEFAULT_REPLY)

            if (reply === OUT_OF_DOMAIN || reply.startsWith(OUT_OF_DOMAIN)) {
              let alreadySentOD = false
              try {
                alreadySentOD = !!(await redis.get(`out_of_domain:${userId}`))
                if (!alreadySentOD) await redis.set(`out_of_domain:${userId}`, '1', { ex: OUT_OF_DOMAIN_TTL })
              } catch { /* */ }
              if (!alreadySentOD) await fbSend(psid, OUT_OF_DOMAIN_MSG)
              return
            }

            if (reply === NOT_FOUND) {
              try {
                const retryKey = `retry:${userId}`
                const hasRetried = await redis.get(retryKey)
                if (hasRetried) {
                  await redis.del(retryKey)
                  await fbSend(psid, handoffMsg)
                  await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
                } else {
                  await redis.set(retryKey, '1', { ex: RETRY_TTL })
                  const retryMsg = 'ขออภัยค่ะ ไม่พบข้อมูลในระบบ สามารถติดต่อแอดมินหรือช่างเทคนิคได้ในเวลาทำการ 08:00–17:00 น. ค่ะ'
                  await fbSend(psid, retryMsg)
                  await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: retryMsg }])
                }
              } catch {
                await fbSend(psid, handoffMsg)
              }
              return
            }

            await fbSend(psid, reply)
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reply }])
            log.info('fb.reply.sent', { userId, latencyMs: Date.now() - startTime, replyLength: reply.length })
          }

          // --- IMAGE ---
          if (event.message?.attachments?.some(a => a.type === 'image')) {
            const history = await getHistory(userId)
            if (offHoursNotice) await fbSend(psid, OFF_HOURS_NOTICE)
            if (showGreeting) {
              await fbSendQuickReplies(
                psid,
                'Spenderclub ยินดีให้บริการค่ะ',
                [
                  { title: 'สอบถาม Spendernetwork', payload: 'QUERY_SPENDERNETWORK' },
                  { title: 'วิทยุสื่อสาร/ราคา', payload: 'QUERY_RADIO' },
                  { title: 'แจ้งปัญหาการใช้งาน', payload: 'REPORT_ISSUE' },
                ]
              )
            }
            await fbSendQuickReplies(
              psid,
              'ต้องการให้น้องใจดีช่วยเรื่องอะไรคะ รบกวนเลือกหัวข้อด้านล่างให้เจ้าหน้าที่หรือระบบดูแลต่อได้เลยค่ะ',
              [
                { title: 'สอบถามสเปก/ฟังก์ชัน', payload: 'QUERY_SPEC' },
                { title: 'ติดต่อศูนย์บริการ', payload: 'CONTACT_SERVICE' },
                { title: 'แจ้งปัญหา/ปรึกษาช่าง', payload: 'REPORT_ISSUE' },
              ]
            )
            await saveHistory(userId, [...history, { role: 'user', text: '[รูปภาพ]' }, { role: 'model', text: '[แสดงเมนู]' }])
            log.info('fb.image.menu_sent', { userId })
          }

          // --- POSTBACK (quick reply tapped) ---
          if (event.postback) {
            const { payload, title } = event.postback
            const history = await getHistory(userId)
            const handoffMsg = getHandoffMessage()
            const faqText = await fetchFAQ()

            let queryText = title
            if (payload === 'QUERY_SPENDERNETWORK') queryText = 'สอบถาม Spendernetwork'
            else if (payload === 'QUERY_RADIO') queryText = 'สอบถามการใช้งานและราคาวิทยุสื่อสาร'
            else if (payload === 'REPORT_ISSUE') queryText = 'แจ้งปัญหาการใช้งาน'
            else if (payload === 'QUERY_SPEC') queryText = 'สอบถามสเปกและฟังก์ชันการใช้งาน'
            else if (payload === 'CONTACT_SERVICE') queryText = 'ติดต่อศูนย์บริการ'

            if (shouldHandoff(queryText)) {
              await fbSend(psid, handoffMsg)
              return
            }

            const reply = await Promise.race([
              generateReply(queryText, faqText, history, handoffMsg),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('gemini_timeout')), 12000)
              ),
            ]).catch(() => DEFAULT_REPLY)

            const finalReply = reply === NOT_FOUND || reply === OUT_OF_DOMAIN ? DEFAULT_REPLY : reply
            await fbSend(psid, finalReply)
            await saveHistory(userId, [...history, { role: 'user', text: queryText }, { role: 'model', text: finalReply }])
            log.info('fb.postback.replied', { userId, payload, latencyMs: Date.now() - startTime })
          }

        } catch (err) {
          log.error('fb.webhook.error', { err: (err as Error).message, userId })
          try { await fbSend(psid, DEFAULT_REPLY) } catch { /* swallow */ }
        }
      })
    )
  )

  return NextResponse.json({ ok: true })
}
