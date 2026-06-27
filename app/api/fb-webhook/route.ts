import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply, generateReplyWithImage } from '@/lib/gemini'
import { shouldHandoff, notifyAdminFacebook } from '@/lib/handoff'
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
const LAST_ANSWER_TTL = 2 * 60
const MSG_RATE_TTL = 10
const MSG_RATE_LIMIT = 5
const NONSENSE_TTL = 10 * 60
const FB_IMG_TTL = 300             // 5 นาที — เก็บ URL รูปไว้ให้ spec handler ใช้

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

          // --- TEXT (ข้ามถ้าเป็น image+caption — IMAGE handler จัดการเอง) ---
          if (event.message?.text && !event.message.attachments?.some(a => a.type === 'image')) {
            const userMessage = event.message.text
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

            // ลูกค้ากด [สเปค/ฟังก์ชัน] จาก image quick reply → โหลดรูปที่บันทึกไว้
            if (userMessage === 'สเปค/ฟังก์ชัน') {
              let fbImgUrl: string | null = null
              try {
                fbImgUrl = await redis.get<string>(`fb_img_url:${userId}`)
                if (fbImgUrl) await redis.del(`fb_img_url:${userId}`)
              } catch { /* Redis ล่ม */ }

              if (fbImgUrl) {
                if (offHoursNotice) await fbSend(psid, OFF_HOURS_NOTICE)
                try {
                  const imgRes = await fetch(fbImgUrl, { signal: AbortSignal.timeout(8000) })
                  const b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64')
                  const faqText = await fetchFAQ()
                  const reply = await Promise.race([
                    generateReplyWithImage(b64, faqText, 'สอบถามสเปกและฟังก์ชันการใช้งาน'),
                    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
                  ]).catch(() => DEFAULT_REPLY)
                  await fbSend(psid, reply)
                  await saveHistory(userId, [...history, { role: 'user', text: 'สเปค/ฟังก์ชัน' }, { role: 'model', text: reply }])
                  log.info('fb.image_spec.sent', { userId, latencyMs: Date.now() - startTime })
                } catch (err) {
                  log.error('fb.image_spec.failed', { userId, err: (err as Error).message })
                  await fbSend(psid, DEFAULT_REPLY)
                }
                return
              }
              // ไม่มีรูปเก็บไว้ → ตกลงไป FAQ flow ปกติ
            }

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
                await notifyAdminFacebook(psid, `[เรื่องที่ต้องการ]: ${pendingTrigger}\n[รายละเอียด]: ${userMessage}`)
              } catch (notifyErr) {
                log.error('fb.handoff.notify_failed', { err: (notifyErr as Error).message, userId })
              }
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

            // CANCEL_IMEI — ลูกค้ายกเลิก IMEI protocol
            if (reply === 'CANCEL_IMEI') {
              const cancelMsg = 'ยกเลิกรายการแล้วค่ะ มีอะไรให้น้องใจดีช่วยอีกไหมคะ'
              await fbSend(psid, cancelMsg)
              await saveHistory(userId, [])
              log.info('fb.imei.cancelled', { userId })
              return
            }

            // HANDOFF / HANDOFF: — Gemini ส่งต่อแอดมิน (IMEI confirm หรือ repair)
            if (reply === 'HANDOFF' || reply.toUpperCase().startsWith('HANDOFF')) {
              const summary = reply.replace(/^HANDOFF[:\s]*/i, '').trim() || 'ลูกค้าต้องการติดต่อแอดมิน'
              try {
                await redis.set(`routed:${userId}`, '1', { ex: 300 })
                await notifyAdminFacebook(psid, `[สรุปคำสั่ง]: ${summary}`)
              } catch (notifyErr) {
                log.error('fb.handoff.notify_failed', { err: (notifyErr as Error).message, userId })
              }
              await fbSend(psid, handoffMsg)
              await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
              log.info('fb.handoff.imei_confirmed', { userId, latencyMs: Date.now() - startTime, summary })
              return
            }

            // ชั้น 3: out-of-domain/nonsense — ตอบครั้งแรก เงียบถ้าซ้ำใน 10 นาที
            if (reply === OUT_OF_DOMAIN || reply.startsWith(OUT_OF_DOMAIN)) {
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
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: OUT_OF_DOMAIN_MSG }])
                log.info('fb.reply.out_of_domain', { userId })
              } else {
                log.info('fb.reply.nonsense_suppressed', { userId, nonsenseCount })
              }
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

            // ชั้น 1: กันตอบซ้ำเป๊ะ — ครั้งที่ 2 reminder, ครั้งที่ 3+ เงียบ
            try {
              const lastAnswer = await redis.get<string>(`last_answer:${userId}`)
              if (lastAnswer && lastAnswer === reply) {
                const [repeatCount] = await redis.pipeline()
                  .incr(`repeat_count:${userId}`)
                  .expire(`repeat_count:${userId}`, LAST_ANSWER_TTL)
                  .exec() as [number, number]
                if (repeatCount === 1) {
                  const reminder = 'ข้อมูลเดิมตามที่แจ้งไปนะคะ ไม่ทราบว่ามีอะไรให้น้องใจดีช่วยเพิ่มเติมไหมคะ 😊'
                  await fbSend(psid, reminder)
                  await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reminder }])
                  log.info('fb.reply.duplicate_reminded', { userId })
                } else {
                  log.info('fb.reply.duplicate_suppressed', { userId, repeatCount })
                }
                return
              }
              await redis.set(`last_answer:${userId}`, reply, { ex: LAST_ANSWER_TTL })
              await redis.del(`repeat_count:${userId}`)
            } catch { /* Redis ล่ม — ส่งปกติ */ }

            await fbSend(psid, reply)
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reply }])
            log.info('fb.reply.sent', { userId, latencyMs: Date.now() - startTime, replyLength: reply.length })
          }

          // --- IMAGE (รวมกรณีรูป + caption ในข้อความเดียว) ---
          if (event.message?.attachments?.some(a => a.type === 'image')) {
            const history = await getHistory(userId)
            const imageUrl = event.message?.attachments?.find(a => a.type === 'image')?.payload?.url
            const caption = event.message?.text

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

            // 5.1: ตอบรับทันที
            await fbSend(psid, 'ได้รับรูปแล้วค่ะ กำลังดูให้นะคะ 📷')

            if (!imageUrl) {
              await fbSend(psid, 'รบกวนพิมพ์ชื่อรุ่นที่สนใจได้ไหมคะ จะได้ช่วยหาข้อมูลให้ถูกต้องค่ะ')
              log.info('fb.image.no_url', { userId })
              return
            }

            // ดาวน์โหลดรูป (Facebook ส่ง URL มาตรงๆ)
            let b64 = ''
            try {
              const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) })
              b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64')
            } catch (err) {
              log.error('fb.image.download_failed', { userId, err: (err as Error).message })
              await fbSend(psid, 'รบกวนพิมพ์ชื่อรุ่นที่สนใจได้ไหมคะ จะได้ช่วยหาข้อมูลให้ถูกต้องค่ะ')
              return
            }

            // กรณีส่งรูป + caption พร้อมกัน → process ทันที ไม่ต้องรอ
            if (caption) {
              const faqText = await fetchFAQ()
              const reply = await Promise.race([
                generateReplyWithImage(b64, faqText, caption),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
              ]).catch(() => DEFAULT_REPLY)
              await fbSend(psid, reply)
              await saveHistory(userId, [...history, { role: 'user', text: `[รูปภาพ] ${caption}` }, { role: 'model', text: reply }])
              log.info('fb.image_caption.sent', { userId, latencyMs: Date.now() - startTime })
              return
            }

            // OCR — ระบุยี่ห้อ/รุ่น
            let ocrProduct: string | null = null
            try {
              const { GoogleGenAI } = await import('@google/genai')
              const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })
              const ocrRes = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [
                  { text: 'ระบุยี่ห้อและรุ่นสินค้าในรูปนี้ ตอบสั้นๆ เช่น "Spender TC-4M" ถ้าไม่เจอตอบว่า "ไม่ระบุ"' },
                  { inlineData: { mimeType: 'image/jpeg', data: b64 } },
                ]}],
                config: { maxOutputTokens: 50, temperature: 0 },
              })
              ocrProduct = ocrRes.text?.trim() || 'ไม่ระบุ'
              await saveHistory(userId, [...history, { role: 'user', text: `[ลูกค้าส่งรูปภาพสินค้า: ${ocrProduct}]` }, { role: 'model', text: '[แสดงเมนูตัวเลือก]' }])
              log.info('fb.image.ocr_saved', { userId, product: ocrProduct })
            } catch { /* OCR ล้มเหลว */ }

            // 5.2: ไม่เจอรุ่น → ถามชื่อรุ่น
            if (ocrProduct === 'ไม่ระบุ') {
              await fbSend(psid, 'รบกวนพิมพ์ชื่อรุ่นที่สนใจได้ไหมคะ จะได้ช่วยหาข้อมูลให้ถูกต้องค่ะ')
              log.info('fb.image.ocr_not_found', { userId })
              return
            }

            // 5.3: เจอรุ่น → บันทึก URL + quick reply ผูก model
            try {
              await redis.set(`fb_img_url:${userId}`, imageUrl, { ex: FB_IMG_TTL })
            } catch { /* Redis ล่ม */ }

            const priceBtn = (`ราคา ${ocrProduct ?? ''}`).slice(0, 20)
            await fbSendQuickReplies(
              psid,
              'ต้องการให้น้องใจดีช่วยเรื่องอะไรคะ',
              [
                { title: priceBtn, payload: 'IMG_PRICE' },
                { title: 'สเปค/ฟังก์ชัน', payload: 'QUERY_SPEC' },
                { title: 'วิธีสั่งซื้อ', payload: 'QUERY_ORDER' },
              ]
            )
            log.info('fb.image.intent_sent', { userId, product: ocrProduct ?? 'unknown', latencyMs: Date.now() - startTime })
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
