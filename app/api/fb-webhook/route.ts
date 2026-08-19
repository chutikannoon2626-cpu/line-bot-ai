import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { fetchFAQ, findExactMatch } from '@/lib/sheet'
import { generateReply, generateReplyWithImage, analyzeImageIntent, analyzeImageWithText } from '@/lib/gemini'
import { shouldHandoff, shouldHandoffImmediate, shouldHandoffDeferred, isOwnerRequest, OWNER_REQUEST_OFF_HOURS_MSG, notifyAdminFacebook } from '@/lib/handoff'
import { redis } from '@/lib/redis'
import { getHistory, saveHistoryExtended } from '@/lib/history'
import { log } from '@/lib/log'
import { isScheduledOff } from '@/lib/schedule'
import { getActiveHolidayNotice } from '@/lib/holidays'
import { shouldGreet, getWelcomeMessage } from '@/lib/greeting'
import { logChat } from '@/lib/chatlog'
import { withUserSendLock } from '@/lib/sendLock'

export const runtime = 'nodejs'
export const maxDuration = 60

const NOT_FOUND = '[NOT_FOUND]'
const OUT_OF_DOMAIN = '[OUT_OF_DOMAIN]'
const OUT_OF_DOMAIN_MSG = 'น้องใจดีเป็นผู้ช่วยด้านวิทยุสื่อสารเท่านั้นค่ะ ต้องการสอบถามข้อมูลวิทยุสื่อสารรุ่นไหนคะ'
const DEFAULT_REPLY = 'ขออภัยค่ะ น้องใจดีไม่พบข้อมูล ต้องการติดต่อแอดมินแจ้งได้เลยนะคะ'
const PRE_HANDOFF_TTL = 600
const RETRY_TTL = 600
const HOLIDAY_NOTIFIED_TTL = 23 * 3600
const LAST_ANSWER_TTL = 2 * 60
const MSG_RATE_TTL = 10
const MSG_RATE_LIMIT = 5
const NONSENSE_TTL = 10 * 60
const FB_IMG_TTL = 600             // 10 นาที
const GEMINI_UNAVAILABLE = '[GEMINI_UNAVAILABLE]'
const UNAVAILABLE_MSG = 'ขออภัยค่ะ ระบบกำลังประมวลผลนานกว่าปกติ 🙏\nแอดมินจะรีบตอบกลับในเวลาทำการ 08:00–17:00 น. นะคะ'
// รูปภาพประเภท E (มีข้อความ/แบบฟอร์ม/บทสนทนาของบุคคลที่สาม) — handoff ทันทีไม่ผ่านขั้นยืนยัน
// ไม่ไหลเข้า protocol ไหนเลย (2026-08-06, ส่วนที่ 2 ของงานจำแนกรูปภาพ)
const IMAGE_HANDOFF_MSG = 'รบกวนรอแอดมินตรวจสอบและติดต่อกลับนะคะ 🙏'

// ลูกค้ายืนยันสั่งซื้อ (เช่น "สั่งเลยค่ะ" หลังบอทเสนอราคา) — ตอบตามเวลาทำการ ไม่ผ่าน Gemini
const ORDER_CONFIRM_TTL = 20 * 60 // 20 นาที กันตอบซ้ำ (เฉพาะในเวลาทำการ)
const ORDER_CONFIRM_RE = /สั่งเลย|อยากสั่ง|ต้องการซื้อ|จะซื้อ|สั่งได้ไหม|ซื้อยังไง|โอนเงิน|ชำระเงิน|จ่ายเงิน/u
const ORDER_CONFIRM_WAIT_MSG = 'กรุณารอสักครู่นะคะ'
const ORDER_CONFIRM_OFF_HOURS_MSG = 'ขณะนี้อยู่นอกเวลาทำการ โดยเจ้าหน้าที่จะเริ่มให้บริการในช่วงเวลา 08:00–17:00 น. นะคะ ลูกค้าสามารถพิมพ์ข้อความไว้โดยเจ้าหน้าที่จะรีบตอบกลับในวันทำการถัดไปนะคะ'

function getHandoffMessage(): string {
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  return thaiHour >= 18 || thaiHour < 8
    ? 'ขณะนี้อยู่นอกเวลาทำการ รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานให้บริการในเวลาทำการ 08:00–17:00 น. ค่ะ'
    : 'รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานกำลังดูแลท่านอยู่ค่ะ'
}

// เรื่อง Spendernetwork (เข้า/ลบ/ย้ายกลุ่ม, ปัญหาการใช้งาน) — เฉพาะ Facebook ให้ชี้ทางไป LINE
// แทน handoffMsg ทั่วไป เพราะงานดูแลระบบ Spendernetwork ทำผ่านทีมที่ดูแลทาง LINE เป็นหลัก
// ใช้ข้อความเดียวกันทุกจุดที่เกี่ยวกับ Spendernetwork บน Facebook: HANDOFF ที่มี IMEI,
// คำขอเข้า/ลบกลุ่มที่ตรวจจับได้ทันที (isSpendernetworkRequest), และ guardrail กำกวมใน lib/prompts.ts (2026-08-01)
function getSpendernetworkRedirectMessage(): string {
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  const base = 'เกี่ยวกับการเข้า/ลบกลุ่มสาธารณะ หรือการใช้งาน/ปัญหาระบบ Spendernetwork รบกวนลูกค้าแอดไลน์ @spenderclub ได้เลยนะคะ 😊 มีทีมซัพพอร์ตพร้อมดูแลลูกค้าโดยตรง ให้บริการตั้งแต่เวลา 08:00–17:00 น. ค่ะ'
  return thaiHour >= 18 || thaiHour < 8
    ? `ขณะนี้อยู่นอกเวลาทำการค่ะ 🙏 ${base}`
    : base
}

// ตรวจจับคำขอเรื่อง Spendernetwork แบบทันที (ก่อนค้น FAQ/เรียก Gemini) — เฉพาะ Facebook เท่านั้น
// แยกจาก lib/handoff.ts โดยตั้งใจ เพราะ shouldHandoffDeferred/Immediate ใช้ร่วมกับ LINE ด้วย
// ถ้าไปเพิ่มคำพวกนี้ในนั้นจะกระทบ LINE โดยไม่ตั้งใจ ทั้งที่ LINE มีทีมดูแลเรื่องนี้แยกอยู่แล้ว (2026-08-01)
const SPENDERNETWORK_TRIGGERS = ['เข้ากลุ่ม', 'ลบกลุ่ม', 'เพิ่มกลุ่ม', 'กลุ่มสาธารณะ', 'กลุ่มปิด', 'spendernetwork']
function isSpendernetworkRequest(message: string): boolean {
  const lower = message.toLowerCase()
  return SPENDERNETWORK_TRIGGERS.some((trigger) => lower.includes(trigger.toLowerCase()))
}

// ส่งข้อความ text ผ่าน Facebook Send API — เช็ค response.ok จริง (เดิม fetch() ไม่ throw ตอนเจอ
// HTTP error status เช่น 429 ทำให้โค้ดคิดว่าส่งสำเร็จทั้งที่จริงไม่ถึงลูกค้าเลย) ถ้าเจอ 429 (rate limit
// ชั่วคราว) รอแล้วลองใหม่ สูงสุด 2 ครั้งเพิ่ม (backoff เพิ่มขึ้นเรื่อยๆ 800ms → 1500ms) รวมสูงสุด
// 3 ครั้ง — ปรับจาก retry ครั้งเดียวเป็นหลายครั้งเพราะพบเคสจริงที่ 429 ยังไม่หายหลัง retry แค่ 1
// ครั้ง (2026-08-04)
const FB_SEND_RETRY_DELAYS_MS = [800, 1500]

async function fbSendRequest(psid: string, text: string): Promise<Response> {
  return fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, message: { text } }),
      signal: AbortSignal.timeout(5000),
    }
  )
}

// ห่อด้วย withUserSendLock (namespace แยกจาก LINE ด้วย prefix "fb:") กันข้อความอื่นจาก
// ลูกค้าคนเดียวกันยิง Send API แทรกกลางระหว่าง retry ของข้อความนี้ (2026-08-05)
async function fbSend(psid: string, text: string) {
  await withUserSendLock(`fb:${psid}`, async () => {
    try {
      let res = await fbSendRequest(psid, text)
      for (const delay of FB_SEND_RETRY_DELAYS_MS) {
        if (res.status !== 429) break
        await new Promise((r) => setTimeout(r, delay))
        res = await fbSendRequest(psid, text)
      }
      if (!res.ok) throw new Error(`${res.status} - ${res.statusText}`)
      logChat({ userId: `fb:${psid}`, channel: 'Facebook', role: 'bot', message: text, ts: Date.now() })
    } catch (err) {
      log.error('fb.send_failed', { psid, err: (err as Error).message })
      notifyAdminFacebook(psid, '⚠️ ส่งข้อความหาลูกค้าไม่สำเร็จ กรุณาติดต่อลูกค้าเองด้วยค่ะ').catch(() => {})
    }
  })
}

// ดึง URL สินค้า spenderclub.com จากข้อความ Gemini
function extractProductUrl(text: string): string | null {
  const m = text.match(/https?:\/\/(?:www\.)?spenderclub\.com\/\S+/)
  return m ? m[0].replace(/[).,'"]+$/, '') : null
}

// ส่ง Generic Template card (มี URL สินค้า) — ห่อด้วย withUserSendLock เหมือน fbSend (2026-08-05)
async function fbSendProductCard(psid: string, reply: string, url: string) {
  await withUserSendLock(`fb:${psid}`, async () => {
    const clean = reply.replace(url, '').replace(/\n{2,}/g, '\n').trim()
    const lines = clean.split('\n').map((l: string) => l.trim()).filter(Boolean)
    const title = (lines[0] ?? 'Spender Club').slice(0, 80)
    const subtitle = lines.slice(1).join(' ').slice(0, 200) || title

    await fetch(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: psid },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'generic',
                elements: [{
                  title,
                  subtitle,
                  buttons: [
                    { type: 'web_url', url, title: 'ดูรายละเอียด/ราคา' },
                    { type: 'postback', title: 'สอบถามเพิ่มเติม', payload: 'CONTACT_ADMIN' },
                  ],
                }],
              },
            },
          },
        }),
        signal: AbortSignal.timeout(5000),
      }
    ).catch(err => log.error('fb.card_failed', { psid, err: (err as Error).message }))
    logChat({ userId: `fb:${psid}`, channel: 'Facebook', role: 'bot', message: reply, ts: Date.now() })
  })
}

// ส่ง reply อัตโนมัติ — ถ้ามี URL สินค้า → Generic Template card, ไม่มี → plain text
async function fbSendReply(psid: string, reply: string) {
  const url = extractProductUrl(reply)
  if (url) await fbSendProductCard(psid, reply, url)
  else await fbSend(psid, reply)
}

// ส่ง Quick Replies — ห่อด้วย withUserSendLock เหมือน fbSend (2026-08-05)
async function fbSendQuickReplies(
  psid: string,
  text: string,
  buttons: { title: string; payload: string }[]
) {
  await withUserSendLock(`fb:${psid}`, async () => {
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
  })
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
    mid?: string
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

        // กัน Facebook ส่ง event ซ้ำ (retry ตอนเซิร์ฟเวอร์ตอบช้า) — ถ้าเคยประมวลผล message ID นี้แล้ว
        // ข้ามทันที กันตอบลูกค้าซ้ำ 2 รอบ (2026-08-04)
        const messageId = event.message?.mid
        if (messageId) {
          try {
            const isNew = await redis.set(`msgid:${messageId}`, '1', { ex: 120, nx: true })
            if (!isNew) {
              log.info('webhook.duplicate_event_skipped', { messageId })
              return
            }
          } catch { /* Redis ล่ม — ประมวลผลต่อตามปกติ */ }
        }

        try {
          // --- SESSION GREETING ---
          const thaiHour = (new Date().getUTCHours() + 7) % 24

          // ประกาศวันหยุด (ตั้งค่าได้ที่ /admin/holidays) — บอทยังตอบตามปกติ แค่แนบข้อความแจ้งไปด้วยครั้งแรกของวัน
          let holidayNotice: string | null = null
          try {
            const notice = await getActiveHolidayNotice()
            if (notice) {
              const alreadyNotified = await redis.get(`holiday_notified:${userId}`)
              if (!alreadyNotified) {
                await redis.set(`holiday_notified:${userId}`, '1', { ex: HOLIDAY_NOTIFIED_TTL })
                holidayNotice = notice
              }
            }
          } catch { /* Redis ล่ม — ข้าม */ }

          const greetFirst = await shouldGreet(userId)

          // --- TEXT (ข้ามถ้าเป็น image+caption — IMAGE handler จัดการเอง) ---
          if (event.message?.text && !event.message.attachments?.some(a => a.type === 'image')) {
            const userMessage = event.message.text
            log.info('webhook.message_received', { userId })
            logChat({ userId, channel: 'Facebook', role: 'user', message: userMessage, ts: Date.now() })
            const history = await getHistory(userId)
            const handoffMsg = getHandoffMessage()

            // ชั้น 2: rate limit — กัน spam ยิงรัว
            try {
              const [rate] = await redis.pipeline()
                .incr(`msg_rate:${userId}`)
                .expire(`msg_rate:${userId}`, MSG_RATE_TTL)
                .exec() as [number, number]
              if (rate > MSG_RATE_LIMIT) {
                if (rate === MSG_RATE_LIMIT + 1) {
                  await fbSend(psid, 'รอสักครู่นะคะ น้องใจดีกำลังอ่านข้อความค่ะ 🙏')
                  log.info('fb.reply.rate_limit_warned', { userId, rate })
                } else {
                  log.info('fb.reply.rate_limited', { userId, rate })
                }
                return
              }
            } catch { /* Redis ล่ม — ข้าม */ }

            // ตรวจ schedule — ถ้าอยู่ในช่วงปิดบอท ไม่ตอบ (แอดมินดูแลเอง)
            // (ยกเลิกเรื่องที่ 39, 2026-08-10 — เดิมเคยเก็บข้อความลูกค้าไว้ใน history ระหว่างปิดบอทเพื่อ
            // ให้บอทดึงมาต่อเวลาเปิดใหม่ แต่เจอปัญหาจริง: แอดมินมักคุยจบเรื่องกับลูกค้าเองนอกระบบไปแล้ว
            // ระหว่างปิดบอท พอบอทเปิดกลับไปหยิบ history เก่าที่ยังไม่หมดอายุมาต่อ ทำให้ดึงเรื่องที่จบไปแล้ว
            // กลับมาคุยซ้ำ — กลับไปเงียบเฉยๆ ไม่บันทึกอะไรเหมือนก่อนเรื่องที่ 39 ทุกประการ)
            if (await isScheduledOff('fb')) {
              log.info('fb.reply.scheduled_off', { userId })
              return
            }

            // ลูกค้ากด [สเปค/ฟังก์ชัน] จาก image quick reply → โหลดรูปที่บันทึกไว้ (อ่านจาก
            // fb_img_list: เอารูปแรกพอ เพราะ generateReplyWithImage() ยังเป็นฟังก์ชันรูปเดียว) (2026-08-05)
            if (userMessage === 'สเปค/ฟังก์ชัน') {
              let fbImgUrl: string | null = null
              try {
                const raw = await redis.lrange<string>(`fb_img_list:${userId}`, 0, 0)
                fbImgUrl = raw[0] ?? null
                await redis.del(`fb_img_list:${userId}`)
              } catch { /* Redis ล่ม */ }

              if (fbImgUrl) {
                if (holidayNotice) await fbSend(psid, holidayNotice)
                try {
                  const imgRes = await fetch(fbImgUrl, { signal: AbortSignal.timeout(8000) })
                  const b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64')
                  const faqText = await fetchFAQ()
                  const reply = await Promise.race([
                    generateReplyWithImage(b64, faqText, 'สอบถามสเปกและฟังก์ชันการใช้งาน', 'facebook'),
                    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
                  ]).catch(() => UNAVAILABLE_MSG)
                  await fbSendReply(psid, reply)
                  await saveHistoryExtended(userId, [...history, { role: 'user', text: 'สเปค/ฟังก์ชัน' }, { role: 'model', text: reply }])
                  log.info('fb.image_spec.sent', { userId, latencyMs: Date.now() - startTime })
                } catch (err) {
                  log.error('fb.image_spec.failed', { userId, err: (err as Error).message })
                  await fbSend(psid, UNAVAILABLE_MSG)
                }
                return
              }
              // ไม่มีรูปเก็บไว้ → ตกลงไป FAQ flow ปกติ
            }

            // Holiday notice (ส่งก่อน reply)
            if (holidayNotice) await fbSend(psid, holidayNotice)

            // Greeting — ทักทายครั้งแรก (24h)
            if (greetFirst) await fbSend(psid, getWelcomeMessage())

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
              // (เรื่องที่ 42) ไม่ notifyAdminFacebook() อีกต่อไปสำหรับ pre-handoff trigger — แอดมิน
              // เช็คแชทเองเป็นปกติอยู่แล้ว เหมือนที่ตัดสินใจไว้กับ HANDOFF sentinel (เรื่องที่ 37) และ
              // Type D fallback ฝั่งรูปภาพ (เรื่องที่ 35) — ให้สม่ำเสมอกันทั้งหมด redis state คงเดิม
              try {
                await Promise.all([
                  redis.set(`routed:${userId}`, '1', { ex: 300 }),
                  redis.del(`handoff_notified:${userId}`),
                ])
              } catch (stateErr) {
                log.error('fb.handoff.state_failed', { err: (stateErr as Error).message, userId })
              }
              await fbSend(psid, handoffMsg)
              await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
              log.info('fb.handoff.after_pre_handoff', { userId, latencyMs: Date.now() - startTime })
              return
            }

            // "ขอเจ้าของ" นอกเวลาทำการ — ไม่ handoff เลย ตอบข้อความนอกเวลาแทน
            if (isOwnerRequest(userMessage) && (thaiHour >= 18 || thaiHour < 8)) {
              await fbSend(psid, OWNER_REQUEST_OFF_HOURS_MSG)
              await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: OWNER_REQUEST_OFF_HOURS_MSG }])
              log.info('fb.handoff.owner_request_off_hours', { userId })
              return
            }

            if (shouldHandoffImmediate(userMessage) || isOwnerRequest(userMessage)) {
              let alreadyRouted = false
              try { alreadyRouted = !!(await redis.get(`routed:${userId}`)) } catch { /* */ }

              if (alreadyRouted) {
                try {
                  const [count] = await redis.pipeline()
                    .incr(`handoff_notified:${userId}`)
                    .expire(`handoff_notified:${userId}`, 10 * 60)
                    .exec() as [number, number]
                  if (count === 1) {
                    await fbSend(psid, 'แอดมินจะติดต่อกลับในเวลาทำการนะคะ 🙏\n🕐 เวลาทำการ 08:00–17:00 น. (จันทร์–เสาร์)')
                    log.info('fb.handoff.already_routed_ack', { userId })
                  } else {
                    log.info('fb.handoff.already_routed_silent', { userId, count })
                  }
                } catch { /* Redis ล่ม */ }
                return
              }

              try {
                await redis.set(`pre_handoff:${userId}`, userMessage, { ex: PRE_HANDOFF_TTL })
              } catch { log.warn('fb.handoff.save_failed', { userId }) }

              const preHandoffQ = 'กรุณาแจ้งรายละเอียดที่ต้องการให้แอดมินช่วยด้วยนะคะ เพื่อให้ดูแลได้ถูกต้องค่ะ'
              await fbSend(psid, preHandoffQ)
              await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: preHandoffQ }])
              log.info('fb.handoff.pre_handoff_question', { userId, latencyMs: Date.now() - startTime })
              return
            }

            // เรื่อง Spendernetwork (เข้า/ลบ/เพิ่มกลุ่มสาธารณะ ฯลฯ) — ชี้ทางไป LINE ทันที ข้ามค้น FAQ/Gemini
            // ไปเลย เพราะเป็นเรื่องเฉพาะบัญชี/เฉพาะเครื่องที่ FAQ ตอบแทนไม่ได้อยู่ดี ไม่ใช่ handoff จริง
            // (ไม่ set routed/takeover, ไม่ notifyAdminFacebook เพราะยังไม่มีข้อมูลอะไรให้แอดมินดำเนินการ)
            // เฉพาะ Facebook เท่านั้น — ตรวจด้วย isSpendernetworkRequest() แยกจาก lib/handoff.ts
            // ไม่กระทบ LINE เลย (2026-08-01)
            if (isSpendernetworkRequest(userMessage)) {
              try {
                const [count] = await redis.pipeline()
                  .incr(`spendernetwork_notified:${userId}`)
                  .expire(`spendernetwork_notified:${userId}`, 10 * 60)
                  .exec() as [number, number]
                if (count === 1) {
                  const redirectMsg = getSpendernetworkRedirectMessage()
                  await fbSend(psid, redirectMsg)
                  await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: redirectMsg }])
                  log.info('fb.spendernetwork.redirected', { userId })
                } else {
                  log.info('fb.spendernetwork.redirect_suppressed', { userId, count })
                }
              } catch {
                const redirectMsg = getSpendernetworkRedirectMessage()
                await fbSend(psid, redirectMsg)
              }
              return
            }

            // ชั้น 1: กันถามซ้ำเป๊ะ — เทียบ "คำถามลูกค้า" ไม่ใช่ "คำตอบบอท" เช็คก่อน findExactMatch()
            // ด้วย (ไม่ใช่แค่ก่อน Gemini) เพราะ findExactMatch() เองก็ไม่มีระบบกันซ้ำเลย — คำถามที่ตรง
            // keyword ในชีต (เช่น "สอบถามเพิ่มเติม") จะตอบซ้ำเป๊ะไปเรื่อยๆ ไม่มีวันเงียบถ้าไม่กันตรงนี้ก่อน
            try {
              const lastQuestion = await redis.get<string>(`last_question:${userId}`)
              if (lastQuestion && lastQuestion === userMessage) {
                const [repeatCount] = await redis.pipeline()
                  .incr(`repeat_count:${userId}`)
                  .expire(`repeat_count:${userId}`, LAST_ANSWER_TTL)
                  .exec() as [number, number]
                if (repeatCount === 1) {
                  const reminder = 'ข้อมูลเดิมตามที่แจ้งไปนะคะ ไม่ทราบว่ามีอะไรให้น้องใจดีช่วยเพิ่มเติมไหมคะ 😊'
                  await fbSend(psid, reminder)
                  await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reminder }])
                  log.info('fb.reply.duplicate_reminded', { userId })
                } else {
                  log.info('fb.reply.duplicate_suppressed', { userId, repeatCount })
                }
                return
              }
            } catch { /* Redis ล่ม — ดำเนินการต่อปกติ */ }

            // Exact keyword match — คำถามง่าย/ชัดเจนตรงกับชีต ตอบทันทีไม่ผ่าน Gemini
            const exactMatch = await findExactMatch(userMessage)
            if (exactMatch) {
              try {
                await redis.set(`last_question:${userId}`, userMessage, { ex: LAST_ANSWER_TTL })
                await redis.del(`repeat_count:${userId}`)
              } catch { /* Redis ล่ม */ }
              await fbSend(psid, exactMatch)
              await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: exactMatch }])
              log.info('fb.exact_match.sent', { userId, latencyMs: Date.now() - startTime })
              return
            }

            // ลูกค้ายืนยันสั่งซื้อ — ตอบตามเวลาทำการ ไม่ผ่าน Gemini
            if (ORDER_CONFIRM_RE.test(userMessage)) {
              const isOffHours = thaiHour >= 18 || thaiHour < 8
              if (isOffHours) {
                await fbSend(psid, ORDER_CONFIRM_OFF_HOURS_MSG)
                await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: ORDER_CONFIRM_OFF_HOURS_MSG }])
                log.info('fb.order_confirm.off_hours', { userId })
                return
              }

              let alreadyReplied = false
              try {
                alreadyReplied = !!(await redis.get(`order_confirm:${userId}`))
              } catch { /* Redis ล่ม */ }

              if (alreadyReplied) {
                log.info('fb.order_confirm.suppressed', { userId })
                return
              }

              try {
                await redis.set(`order_confirm:${userId}`, '1', { ex: ORDER_CONFIRM_TTL })
              } catch { /* Redis ล่ม */ }
              await fbSend(psid, ORDER_CONFIRM_WAIT_MSG)
              await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: ORDER_CONFIRM_WAIT_MSG }])
              log.info('fb.order_confirm.wait_reply', { userId })
              return
            }


            const faqText = await fetchFAQ()
            const geminiController = new AbortController()
            const geminiTimeoutId = setTimeout(() => geminiController.abort(), 20000)
            const reply = await generateReply(userMessage, faqText, history, handoffMsg, 'facebook', geminiController.signal)
              .catch((err) => {
                log.error('fb.gemini.failed', { err: (err as Error).message, userId })
                return GEMINI_UNAVAILABLE
              })
            clearTimeout(geminiTimeoutId)

            // Gemini ไม่ตอบทัน (timeout, 429, 503)
            if (reply === GEMINI_UNAVAILABLE) {
              await fbSend(psid, UNAVAILABLE_MSG)
              log.info('fb.reply.gemini_unavailable', { userId })
              return
            }

            // CANCEL_IMEI — ลูกค้ายกเลิก IMEI protocol
            if (reply === 'CANCEL_IMEI') {
              const cancelMsg = 'ยกเลิกรายการแล้วค่ะ มีอะไรให้น้องใจดีช่วยอีกไหมคะ'
              await fbSend(psid, cancelMsg)
              await saveHistoryExtended(userId, [])
              log.info('fb.imei.cancelled', { userId })
              return
            }

            // HANDOFF / HANDOFF: — Gemini ส่งต่อแอดมิน (IMEI confirm หรือ repair)
            // ค้นหา "HANDOFF:" ที่ไหนก็ได้ในข้อความ (ไม่ anchor ที่ต้น) เพราะ Gemini บางครั้งใส่ประโยค
            // นำหน้ามาก่อน "HANDOFF:" ทั้งที่ prompt สั่งห้ามไว้ — เดิมใช้ startsWith('HANDOFF') ทำให้เคส
            // แบบนี้หลุดไปทั้งก้อน (ข้อความดิบ + "HANDOFF: ...") ให้ลูกค้าเห็นตรงๆ แทนที่จะถูกแทนด้วย
            // handoffMsg (เจอบั๊กจริงจาก screenshot ลูกค้า 2026-08-07)
            if (reply === 'HANDOFF' || reply.toUpperCase().includes('HANDOFF:')) {
              const summary = reply.replace(/^[\s\S]*?HANDOFF:?\s*/i, '').trim() || 'ลูกค้าต้องการติดต่อแอดมิน'
              // self_repair_protocol ส่ง "...HANDOFF: ขอวิธีทำเอง | ..." มาเฉพาะกรณีถามวิธีทำเอง (ไม่ใช่แจ้งเครื่องเสีย)
              // imei_protocol ส่ง "...| IMEI: ... | ..." — เรื่อง Spendernetwork ให้ชี้ทางไป LINE แทนรอแอดมินทาง Facebook (2026-07-31)
              const replyMsg = /HANDOFF:\s*ขอวิธีทำเอง/i.test(reply)
                ? 'กรุณารอเจ้าหน้าที่เพื่อทำการตรวจสอบและแนะนำวิธีให้อีกครั้งนะคะ'
                : summary.includes('IMEI:')
                ? getSpendernetworkRedirectMessage()
                : handoffMsg
              // (เรื่องที่ 37) ไม่ notifyAdminFacebook() อีกต่อไปสำหรับ handoff ข้อความล้วน — แอดมินเช็คแชทเองเป็นปกติ
              // อยู่แล้ว เหมือนที่ตัดสินใจไว้กับ Type D fallback ฝั่งรูปภาพ (เรื่องที่ 35) — notifyAdminFacebook()
              // เองยังไม่ได้แตะ ยังใช้อยู่ที่ Type E/G/F+สต็อก ฝั่งรูปภาพตามปกติ (line 701/711/738/747)
              try {
                await Promise.all([
                  redis.set(`routed:${userId}`, '1', { ex: 300 }),
                  redis.del(`handoff_notified:${userId}`),
                ])
              } catch (stateErr) {
                log.error('fb.handoff.state_failed', { err: (stateErr as Error).message, userId })
              }
              await fbSend(psid, replyMsg)
              await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: replyMsg }])
              log.info('fb.handoff.imei_confirmed', { userId, latencyMs: Date.now() - startTime, summary })
              return
            }

            // ชั้น 3: out-of-domain/nonsense — ตอบครั้งแรก เงียบถ้าซ้ำใน 10 นาที
            if (reply.includes(OUT_OF_DOMAIN)) {
              let nonsenseCount = 0
              try {
                const [count] = await redis.pipeline()
                  .incr(`nonsense_count:${userId}`)
                  .expire(`nonsense_count:${userId}`, NONSENSE_TTL)
                  .exec() as [number, number]
                nonsenseCount = count
              } catch { /* Redis ล่ม */ }
              if (nonsenseCount <= 1) {
                await fbSend(psid, OUT_OF_DOMAIN_MSG)
                await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: OUT_OF_DOMAIN_MSG }])
                log.info('fb.reply.out_of_domain', { userId })
              } else {
                log.info('fb.reply.nonsense_suppressed', { userId, nonsenseCount })
              }
              return
            }

            if (reply === NOT_FOUND) {
              // ค้นชีต + ค้นเว็บไม่เจอ (NOT_FOUND) + ข้อความมี deferred handoff trigger
              // → ขอรายละเอียดก่อน 1 รอบแล้วค่อย handoff (ข้าม retry 2 รอบปกติ)
              if (shouldHandoffDeferred(userMessage)) {
                try {
                  await redis.set(`pre_handoff:${userId}`, userMessage, { ex: PRE_HANDOFF_TTL })
                } catch { log.warn('fb.handoff.save_failed', { userId }) }

                const preHandoffQ = 'กรุณาแจ้งรายละเอียดที่ต้องการให้แอดมินช่วยด้วยนะคะ เพื่อให้ดูแลได้ถูกต้องค่ะ'
                await fbSend(psid, preHandoffQ)
                await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: preHandoffQ }])
                log.info('fb.handoff.deferred_after_not_found', { userId, latencyMs: Date.now() - startTime })
                return
              }

              try {
                const retryKey = `retry:${userId}`
                const hasRetried = await redis.get(retryKey)
                if (hasRetried) {
                  await redis.del(retryKey)
                  await fbSend(psid, handoffMsg)
                  await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
                } else {
                  await redis.set(retryKey, '1', { ex: RETRY_TTL })
                  const retryMsg = 'ขออภัยค่ะ ไม่พบข้อมูลในระบบ สามารถติดต่อแอดมินหรือช่างเทคนิคได้ในเวลาทำการ 08:00–17:00 น. ค่ะ'
                  await fbSend(psid, retryMsg)
                  await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: retryMsg }])
                  try {
                    await redis.lpush('unanswered_log', JSON.stringify({ ts: new Date().toISOString(), userId, question: userMessage }))
                    await redis.ltrim('unanswered_log', 0, 499)
                  } catch { /* Redis ล่ม — ข้าม */ }
                }
              } catch {
                await fbSend(psid, handoffMsg)
              }
              return
            }

            // จำคำถามล่าสุดไว้เทียบซ้ำรอบหน้า (เฉพาะตอบสำเร็จ — HANDOFF/NOT_FOUND ฯลฯ ไม่นับ)
            try {
              await redis.set(`last_question:${userId}`, userMessage, { ex: LAST_ANSWER_TTL })
              await redis.del(`repeat_count:${userId}`)
            } catch { /* Redis ล่ม — ส่งปกติ */ }

            // กันบอทตอบข้อความเดิมซ้ำติดกัน (เช่น IMEI confirm ถามซ้ำเพราะลูกค้าตอบไม่ตรงเงื่อนไข,
            // group-intent fallback ซ้ำ) — เทียบกับคำตอบ "รอบติดกันล่าสุด" เท่านั้น ถ้าตรงเป๊ะสลับเป็น
            // ข้อความสั้นแทนไม่ให้ดูเหมือนบอทค้าง (2026-08-01)
            let finalReply = reply
            try {
              const lastBotReply = await redis.get<string>(`last_bot_reply:${userId}`)
              await redis.set(`last_bot_reply:${userId}`, reply, { ex: LAST_ANSWER_TTL })
              if (lastBotReply && lastBotReply === reply) finalReply = 'รับทราบค่ะ 🙏'
            } catch { /* Redis ล่ม — ส่งปกติ */ }

            await fbSendReply(psid, finalReply)
            await saveHistoryExtended(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: finalReply }])
            log.info('fb.reply.sent', { userId, latencyMs: Date.now() - startTime, replyLength: finalReply.length })
            try { await redis.zincrby('question_freq', 1, userMessage.slice(0, 100)) } catch { /* Redis ล่ม */ }
          }

          // --- IMAGE (รวมกรณีรูป + caption ในข้อความเดียว) ---
          if (event.message?.attachments?.some(a => a.type === 'image')) {
            // บันทึกฝั่งลูกค้าไว้ก่อน isScheduledOff() check เสมอ (ไม่ว่าบอทเปิดหรือปิด) ให้แอดมิน
            // เห็นในหน้าประวัติแชทว่าลูกค้าส่งรูปมา — คำตอบบอทไม่ต้อง log ซ้ำตรงนี้ เพราะ fbSend()/
            // fbSendReply() ที่ทุกจุดตอบใน branch นี้ใช้อยู่แล้ว log ฝั่งบอทให้อัตโนมัติหลังส่งสำเร็จ
            // (เรื่องที่ 40, 2026-08-08)
            logChat({ userId, channel: 'Facebook', role: 'user', message: '[ลูกค้าส่งรูปภาพ]', ts: Date.now() })

            // ตรวจ schedule — ถ้าอยู่ในช่วงปิดบอท ไม่ตอบ (แอดมินดูแลเอง)
            // (เดิม branch นี้ลืมเช็ค ทำให้บอทตอบรูปภาพได้แม้ตั้งเวลาปิดไว้ — การเช็คนี้คงไว้ ไม่ยกเลิก)
            // (ยกเลิกเรื่องที่ 39, 2026-08-10 — เดิมเคยเก็บไว้ใน history ระหว่างปิดบอทเพื่อดึงมาต่อตอนเปิด
            // เจอปัญหาจริงเหมือน TEXT branch: แอดมินคุยจบเรื่องกับลูกค้าเองนอกระบบไปแล้วระหว่างปิดบอท
            // บอทเปิดมาแล้วดึง history เก่ามาต่อซ้ำ — กลับไปเงียบเฉยๆ ไม่บันทึกอะไรเหมือนก่อนเรื่องที่ 39)
            if (await isScheduledOff('fb')) {
              log.info('fb.image.scheduled_off', { userId })
              return
            }

            const history = await getHistory(userId)
            // .filter() แทน .find() — เดิมดึงมาแค่รูปแรกรูปเดียว ถ้าลูกค้าส่งอัลบั้มหลายรูป
            // พร้อมกันในข้อความเดียว รูปที่ 2 เป็นต้นไปหายไปตั้งแต่ต้นทางเลย (2026-08-05)
            const imageUrls = (event.message?.attachments ?? [])
              .filter(a => a.type === 'image')
              .map(a => a.payload?.url)
              .filter((u): u is string => !!u)
            const caption = event.message?.text

            if (holidayNotice) await fbSend(psid, holidayNotice)
            if (greetFirst) await fbSend(psid, getWelcomeMessage())

            if (imageUrls.length === 0) {
              await fbSend(psid, 'รบกวนพิมพ์ชื่อรุ่นที่สนใจได้ไหมคะ จะได้ช่วยหาข้อมูลให้ถูกต้องค่ะ')
              log.info('fb.image.no_url', { userId })
              return
            }

            // ดาวน์โหลดรูปทั้งหมด (Facebook ส่ง URL มาตรงๆ)
            const base64Images: string[] = []
            try {
              for (const url of imageUrls) {
                const imgRes = await fetch(url, { signal: AbortSignal.timeout(8000) })
                base64Images.push(Buffer.from(await imgRes.arrayBuffer()).toString('base64'))
              }
            } catch (err) {
              log.error('fb.image.download_failed', { userId, err: (err as Error).message })
              await fbSend(psid, 'รบกวนพิมพ์ชื่อรุ่นที่สนใจได้ไหมคะ จะได้ช่วยหาข้อมูลให้ถูกต้องค่ะ')
              return
            }

            // กรณีส่งรูป + caption พร้อมกัน → อ่านรูป+ข้อความพร้อมกัน สรุป+ถามยืนยันก่อนเสมอ
            // แทนตอบทันที (เดิมค้นเว็บอัตโนมัติทุกครั้งผ่าน generateReplyWithImage() แม้คำถามไม่
            // เกี่ยวกับสเปกสินค้าเลยก็ตาม) เมื่อลูกค้ายืนยันแล้วข้อความตอบกลับจะเดินเข้า flow ข้อความ
            // ปกติเอง (ค้นชีตก่อน) (2026-08-01) — timeout dynamic ตามจำนวนรูป (2026-08-05, ปรับเพิ่ม
            // 2026-08-10 ให้ตรงกับ LINE — เจอเคสจริง 2 รูปถ่ายจริง+ข้อความยาว+FAQ เต็ม timeout เดิม
            // ไม่พอ ต้องตกไปตอบ UNAVAILABLE_MSG — capped ที่ 45s กันเกินงบ maxDuration=60s)
            if (caption) {
              // ขยับฐานจาก 25s เป็น 35s ให้ตรงกับ LINE (2026-08-18, เรื่องที่ 54 เดิมแก้แค่
              // line-webhook/route.ts ไม่ได้ sync มาที่นี่ด้วย ทั้งที่โค้ดเหมือนกันเป๊ะ — แก้ตาม
              // ตอนนี้ 2026-08-19, เรื่องที่ 56)
              let imageTextFailureReason: string | null = null
              const dynamicTimeout = Math.min(35000 + 10000 * (base64Images.length - 1), 45000)
              const faqTextForImage = await fetchFAQ()
              const withTextResult = await Promise.race([
                analyzeImageWithText(base64Images, caption, faqTextForImage),
                new Promise<{ kind: 'unclear' }>((_, reject) => setTimeout(() => reject(new Error('timeout')), dynamicTimeout)),
              ]).catch((err) => {
                imageTextFailureReason = (err as Error).message
                log.error('fb.image_text_failed', { err: imageTextFailureReason, userId, imageCount: base64Images.length })
                return { kind: 'unclear' as const }
              })

              if (withTextResult.kind === 'unclear') {
                await fbSend(psid, UNAVAILABLE_MSG)
                const latencyMs = Date.now() - startTime
                log.info('fb.image_text.unclear', { userId, latencyMs, imageCount: base64Images.length })
                // บันทึกถาวรลง Redis แทนพึ่ง Vercel live log อย่างเดียว — sync กับ line-webhook/route.ts
                // (2026-08-19, เรื่องที่ 56) ใช้ key ร่วมกันข้ามช่องทาง แยกด้วย field channel
                try {
                  await redis.lpush('image_text_failure_log', JSON.stringify({
                    ts: new Date().toISOString(), userId, latencyMs, imageCount: base64Images.length,
                    channel: 'facebook', reason: imageTextFailureReason ?? 'model_unclear',
                  }))
                  await redis.ltrim('image_text_failure_log', 0, 499)
                } catch { /* Redis ล่ม — ข้าม */ }
                return
              }

              // ประเภท E (ข้อความ/แบบฟอร์ม/บทสนทนาบุคคลที่สาม) — handoff ทันที ไม่ผ่านขั้นยืนยัน
              // ไม่บันทึก history เป็น pending-confirm เพราะไม่ไหลเข้า protocol ไหนต่อ (2026-08-06)
              if (withTextResult.kind === 'handoff') {
                await fbSend(psid, IMAGE_HANDOFF_MSG)
                notifyAdminFacebook(psid, '⚠️ ลูกค้าส่งรูปภาพที่มีข้อมูลบุคคลที่สาม (แบบฟอร์ม/บทสนทนา) รบกวนตรวจสอบและติดต่อลูกค้าเองด้วยค่ะ').catch(() => {})
                log.info('fb.image_text.handoff', { userId, latencyMs: Date.now() - startTime, imageCount: base64Images.length })
                return
              }

              // ประเภท G (ใบเสร็จ/สลิปขนส่ง/หลักฐานโอนเงิน) หรือ F+ถามสต็อก — รับทราบ/ตอบทันที
              // แล้ว handoff เลย ไม่ผ่านขั้นยืนยัน ไม่บันทึก pending-confirm history (2026-08-06, เรื่องที่ 34)
              if (withTextResult.kind === 'ackHandoff') {
                await fbSend(psid, withTextResult.message)
                notifyAdminFacebook(psid, `⚠️ ลูกค้าส่งรูปภาพ/ข้อความที่ต้องรอแอดมินยืนยัน: ${withTextResult.message}`).catch(() => {})
                log.info('fb.image_text.ack_handoff', { userId, latencyMs: Date.now() - startTime, imageCount: base64Images.length })
                return
              }

              await fbSend(psid, withTextResult.confirmMessage)
              await saveHistoryExtended(userId, [...history, { role: 'user', text: `[รูปภาพ+ข้อความ] ${withTextResult.summary}` }, { role: 'model', text: withTextResult.confirmMessage }])
              log.info('fb.image_text.confirm_sent', { userId, latencyMs: Date.now() - startTime, imageCount: base64Images.length })
              return
            }

            // วิเคราะห์รูป — ระบุยี่ห้อ/รุ่น หรือจำแนกเจตนาอื่น (2026-08-01)
            let intent: Awaited<ReturnType<typeof analyzeImageIntent>> = { kind: 'unclear' }
            try {
              intent = await analyzeImageIntent(base64Images)
              log.info('fb.image.intent_analyzed', { userId, kind: intent.kind, imageCount: base64Images.length })
            } catch { /* วิเคราะห์ล้มเหลว */ }

            // 5.2: อ่านไม่ออก → ถามชื่อรุ่น (พฤติกรรมเดิม)
            if (intent.kind === 'unclear') {
              await fbSend(psid, 'รบกวนพิมพ์ชื่อรุ่นที่สนใจได้ไหมคะ จะได้ช่วยหาข้อมูลให้ถูกต้องค่ะ')
              log.info('fb.image.ocr_not_found', { userId })
              return
            }

            // ประเภท E (ข้อความ/แบบฟอร์ม/บทสนทนาบุคคลที่สาม) — handoff ทันที ไม่ผ่านขั้นยืนยัน (2026-08-06)
            if (intent.kind === 'handoff') {
              await fbSend(psid, IMAGE_HANDOFF_MSG)
              notifyAdminFacebook(psid, '⚠️ ลูกค้าส่งรูปภาพที่มีข้อมูลบุคคลที่สาม (แบบฟอร์ม/บทสนทนา) รบกวนตรวจสอบและติดต่อลูกค้าเองด้วยค่ะ').catch(() => {})
              log.info('fb.image.intent_handoff', { userId })
              return
            }

            // ประเภท G (ใบเสร็จ/สลิปขนส่ง/หลักฐานโอนเงิน) — รับทราบทันที+handoff ไม่ผ่านขั้นยืนยัน (2026-08-06, เรื่องที่ 34)
            if (intent.kind === 'ackHandoff') {
              await fbSend(psid, intent.message)
              notifyAdminFacebook(psid, `⚠️ ลูกค้าส่งรูปภาพที่ต้องรอแอดมินยืนยัน: ${intent.message}`).catch(() => {})
              log.info('fb.image.intent_ack_handoff', { userId })
              return
            }

            // 5.2b: รูปประเภทอื่น (error/IMEI/สกรีนช็อต/เอกสาร) → สรุป+ถามยืนยัน แล้วรอข้อความตอบกลับ
            if (intent.kind === 'other') {
              await saveHistoryExtended(userId, [...history, { role: 'user', text: `[ลูกค้าส่งรูปภาพ: ${intent.summary}]` }, { role: 'model', text: intent.confirmMessage }])
              await fbSend(psid, intent.confirmMessage)
              log.info('fb.image.intent_confirm_sent', { userId, latencyMs: Date.now() - startTime })
              return
            }

            // 5.3: เจอรุ่นสินค้า → บันทึก URL + quick reply ผูก model (พฤติกรรมเดิม)
            // เก็บเป็น list แทน key เดี่ยว (fb_img_list: แทน fb_img_url:) — เผื่อรองรับหลายรูปในอนาคต
            // ตอนนี้ปุ่ม "สเปค/ฟังก์ชัน" ยังใช้ generateReplyWithImage() แบบรูปเดียวเดิม จึงอ่านแค่
            // รูปแรก (product เดียวกันทุกรูปอยู่แล้วตามเงื่อนไขใหม่ของ analyzeImageIntent) (2026-08-05)
            const ocrProduct = intent.product
            await saveHistoryExtended(userId, [...history, { role: 'user', text: `[ลูกค้าส่งรูปภาพสินค้า: ${ocrProduct}]` }, { role: 'model', text: '[แสดงเมนูตัวเลือก]' }])
            try {
              await redis.del(`fb_img_list:${userId}`)
              await redis.rpush(`fb_img_list:${userId}`, ...imageUrls)
              await redis.expire(`fb_img_list:${userId}`, FB_IMG_TTL)
            } catch { /* Redis ล่ม */ }

            const priceBtn = (`ราคา ${ocrProduct}`).slice(0, 20)
            await fbSendQuickReplies(
              psid,
              'ต้องการให้น้องใจดีช่วยเรื่องอะไรคะ',
              [
                { title: priceBtn, payload: 'IMG_PRICE' },
                { title: 'สเปค/ฟังก์ชัน', payload: 'QUERY_SPEC' },
                { title: 'วิธีสั่งซื้อ', payload: 'QUERY_ORDER' },
              ]
            )
            log.info('fb.image.intent_sent', { userId, product: ocrProduct, latencyMs: Date.now() - startTime })
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

            // ชั้น 1: กันถามซ้ำเป๊ะ — เทียบ "คำถาม/ปุ่มที่กด" ไม่ใช่ "คำตอบบอท" (เหมือน text flow ด้านบน)
            try {
              const lastQuestion = await redis.get<string>(`last_question:${userId}`)
              if (lastQuestion && lastQuestion === queryText) {
                const [repeatCount] = await redis.pipeline()
                  .incr(`repeat_count:${userId}`)
                  .expire(`repeat_count:${userId}`, LAST_ANSWER_TTL)
                  .exec() as [number, number]
                if (repeatCount === 1) {
                  const reminder = 'ข้อมูลเดิมตามที่แจ้งไปนะคะ ไม่ทราบว่ามีอะไรให้น้องใจดีช่วยเพิ่มเติมไหมคะ 😊'
                  await fbSend(psid, reminder)
                  await saveHistoryExtended(userId, [...history, { role: 'user', text: queryText }, { role: 'model', text: reminder }])
                  log.info('fb.postback.duplicate_reminded', { userId })
                } else {
                  log.info('fb.postback.duplicate_suppressed', { userId, repeatCount })
                }
                return
              }
            } catch { /* Redis ล่ม — ดำเนินการต่อปกติ */ }

            const geminiController2 = new AbortController()
            const geminiTimeoutId2 = setTimeout(() => geminiController2.abort(), 7000)
            const reply = await generateReply(queryText, faqText, history, handoffMsg, 'facebook', geminiController2.signal)
              .catch(() => GEMINI_UNAVAILABLE)
            clearTimeout(geminiTimeoutId2)

            const finalReply = (reply === NOT_FOUND || reply === OUT_OF_DOMAIN || reply === GEMINI_UNAVAILABLE)
              ? UNAVAILABLE_MSG : reply

            // จำคำถามล่าสุดไว้เทียบซ้ำรอบหน้า
            try {
              await redis.set(`last_question:${userId}`, queryText, { ex: LAST_ANSWER_TTL })
              await redis.del(`repeat_count:${userId}`)
            } catch { /* Redis ล่ม — ส่งปกติ */ }

            await fbSendReply(psid, finalReply)
            await saveHistoryExtended(userId, [...history, { role: 'user', text: queryText }, { role: 'model', text: finalReply }])
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
