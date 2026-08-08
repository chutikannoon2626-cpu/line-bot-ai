import { NextRequest, NextResponse } from 'next/server'
import { validateSignature, messagingApi } from '@line/bot-sdk'
import { fetchFAQ, findExactMatch } from '@/lib/sheet'
import { generateReply, generateReplyWithImage, analyzeImageIntent, analyzeImageWithText } from '@/lib/gemini'
import { shouldHandoffImmediate, shouldHandoffDeferred, isOwnerRequest, OWNER_REQUEST_OFF_HOURS_MSG, notifyAdmin } from '@/lib/handoff'
import { log } from '@/lib/log'
import { redis } from '@/lib/redis'
import { imageIntentCard } from '@/lib/flex-cards'
import { getHistory, saveHistory } from '@/lib/history'
import { isScheduledOff, getRules } from '@/lib/schedule'
import { getActiveHolidayNotice } from '@/lib/holidays'
import { shouldGreet, getWelcomeMessage } from '@/lib/greeting'
import { logChat } from '@/lib/chatlog'
import { withUserSendLock } from '@/lib/sendLock'

const NOT_FOUND = '[NOT_FOUND]'
const GEMINI_UNAVAILABLE = '[GEMINI_UNAVAILABLE]'
const UNAVAILABLE_MSG = 'ขออภัยค่ะ ระบบกำลังประมวลผลนานกว่าปกติ 🙏\nแอดมินจะรีบตอบกลับในเวลาทำการ 08:00–17:00 น. นะคะ'
// รูปภาพประเภท E (มีข้อความ/แบบฟอร์ม/บทสนทนาของบุคคลที่สาม) — handoff ทันทีไม่ผ่านขั้นยืนยัน
// ไม่ไหลเข้า protocol ไหนเลย (2026-08-06, ส่วนที่ 2 ของงานจำแนกรูปภาพ)
const IMAGE_HANDOFF_MSG = 'รบกวนรอแอดมินตรวจสอบและติดต่อกลับนะคะ 🙏'
// ลดจาก 2 ชม. เป็น 1 ชม. (2026-08-08, เรื่องที่ 42) — auto-resume เร็วขึ้น กันแอดมินลืมคืนบอท
// นานเกินไป ตอนนี้เป็นทางออกทางเดียวจาก takeover state แล้ว (ลบคำสั่ง "คืนบอท:" ทิ้งแล้ว)
const TAKEOVER_TTL = 1 * 3600
const OUT_OF_DOMAIN = '[OUT_OF_DOMAIN]'
const OUT_OF_DOMAIN_MSG = 'น้องใจดีเป็นผู้ช่วยด้านวิทยุสื่อสารเท่านั้นค่ะ ต้องการสอบถามข้อมูลวิทยุสื่อสารรุ่นไหนคะ'
const RETRY_TTL = 600
const PRE_HANDOFF_TTL = 600
const HOLIDAY_NOTIFIED_TTL = 23 * 3600
const LAST_ANSWER_TTL = 2 * 60
const MSG_RATE_TTL = 10
const MSG_RATE_LIMIT = 5
const NONSENSE_TTL = 10 * 60

// ลูกค้ายืนยันสั่งซื้อ (เช่น "สั่งเลยค่ะ" หลังบอทเสนอราคา) — ตอบตามเวลาทำการ ไม่ผ่าน Gemini
const ORDER_CONFIRM_TTL = 20 * 60 // 20 นาที กันตอบซ้ำ (เฉพาะในเวลาทำการ)
const ORDER_CONFIRM_RE = /สั่งเลย|อยากสั่ง|ต้องการซื้อ|จะซื้อ|สั่งได้ไหม|ซื้อยังไง|โอนเงิน|ชำระเงิน|จ่ายเงิน/u
const ORDER_CONFIRM_WAIT_MSG = 'กรุณารอสักครู่นะคะ'
const ORDER_CONFIRM_OFF_HOURS_MSG = 'ขณะนี้อยู่นอกเวลาทำการ โดยเจ้าหน้าที่จะเริ่มให้บริการในช่วงเวลา 08:00–17:00 น. นะคะ ลูกค้าสามารถพิมพ์ข้อความไว้โดยเจ้าหน้าที่จะรีบตอบกลับในวันทำการถัดไปนะคะ'

function getHandoffMessage(): string {
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  return thaiHour >= 18 || thaiHour < 8
    ? 'น้องใจดีรับทราบค่ะ และจะแจ้งแอดมินให้ติดต่อกลับในเวลาทำการนะคะ 🙏 ทีมงานให้บริการในเวลาทำการ 08:00–17:00 น. ค่ะ'
    : 'รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานกำลังดูแลท่านอยู่ค่ะ'
}

// คำนวณ TTL ของ saveHistory() แบบไดนามิกช่วงปิดบอทตามตารางเวลา (isScheduledOff = true) — ใช้เวลาที่
// เหลือจริงจนกว่าตารางจะเปิดบอทอีกครั้ง (+buffer 30 นาที) แทน TTL ปกติ 10 นาที กัน history หมดอายุก่อน
// บอทจะกลับมาตอบ · อ่าน rules ที่มีอยู่แล้วมาคำนวณเท่านั้น ไม่แก้ logic การเช็คตารางใน isScheduledOff()
// เลย (มิเรอร์วิธีจับคู่ day/time แบบเดียวกันทุกประการ) · วันที่เปิด 24 ชม. isScheduledOff() จะคืน false
// อยู่แล้วตั้งแต่ต้น ฟังก์ชันนี้เลยไม่ถูกเรียกในวันนั้น ใช้ TTL ปกติ 10 นาทีโดยอัตโนมัติ (เรื่องที่ 39, 2026-08-08)
async function computeOffHoursHistoryTtl(channel: 'line' | 'fb'): Promise<number> {
  const FALLBACK_TTL = 12 * 3600 // คำนวณเวลาเปิดใหม่ไม่ได้ (rules ว่าง/parse พัง) → fallback 12 ชม.
  const BUFFER_SEC = 30 * 60
  try {
    const rules = await getRules(channel)
    const bangkokNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }))
    const dow = bangkokNow.getDay()
    const cur = bangkokNow.getHours() * 60 + bangkokNow.getMinutes()

    let maxRemainingMin = -1
    for (const r of rules) {
      if (!r.enabled || !r.days.includes(dow)) continue
      const [sh, sm] = r.startTime.split(':').map(Number)
      const [eh, em] = r.endTime.split(':').map(Number)
      const start = sh * 60 + sm
      const end = eh * 60 + em
      const isOvernight = start >= end
      const matches = isOvernight ? (cur >= start || cur < end) : (cur >= start && cur < end)
      if (!matches) continue

      const remainingMin = isOvernight
        ? (cur >= start ? (1440 - cur) + end : end - cur)
        : end - cur
      if (remainingMin > maxRemainingMin) maxRemainingMin = remainingMin
    }

    if (maxRemainingMin < 0) return FALLBACK_TTL
    return maxRemainingMin * 60 + BUFFER_SEC
  } catch {
    return FALLBACK_TTL
  }
}

export const runtime = 'nodejs'
export const maxDuration = 60

const DEFAULT_REPLY =
  'ขออภัยค่ะ น้องใจดีไม่พบข้อมูล ต้องการติดต่อแอดมินแจ้งได้เลยนะคะ'

export async function GET() {
  return NextResponse.json({ status: 'ok', ts: new Date().toISOString() })
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-line-signature') ?? ''
  const rawBody = await req.text()

  if (!validateSignature(rawBody, process.env.LINE_CHANNEL_SECRET!, signature)) {
    log.warn('webhook.invalid_signature')
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  const body = JSON.parse(rawBody) as { events: Array<Record<string, unknown>> }

  await Promise.all(
    body.events.map(async (event) => {
      if (event.type !== 'message' || !event.message) return

      // กัน LINE ส่ง event ซ้ำ (retry ตอนเซิร์ฟเวอร์ตอบช้า) — ถ้าเคยประมวลผล message ID นี้แล้ว
      // ข้ามทันที กันแย่ง replyToken/push กันเองจนลูกค้าไม่ได้รับข้อความเลย (2026-08-04)
      const messageId = (event.message as { id?: string }).id
      if (messageId) {
        try {
          const isNew = await redis.set(`msgid:${messageId}`, '1', { ex: 120, nx: true })
          if (!isNew) {
            log.info('webhook.duplicate_event_skipped', { messageId })
            return
          }
        } catch { /* Redis ล่ม — ประมวลผลต่อตามปกติ */ }
      }

      const msgType = (event.message as { type: string }).type
      const replyToken = event.replyToken as string
      const source = event.source as { type: string; userId?: string }
      const userId = source.userId ?? 'unknown'
      const startTime = Date.now()

      const lineClient = new messagingApi.MessagingApiClient({
        channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
      })

      // pushMessage — ถ้าเจอ 429 (rate limit ชั่วคราวจาก LINE) รอแล้วลองใหม่ สูงสุด 2 ครั้งเพิ่ม
      // (backoff เพิ่มขึ้นเรื่อยๆ 800ms → 1500ms) รวมสูงสุด 3 ครั้ง — error อื่นที่ไม่ใช่ 429
      // โยนออกทันทีไม่ retry เพราะรอแล้วก็ไม่ช่วย (2026-08-04, ปรับจาก retry ครั้งเดียวเป็นหลายครั้ง
      // เพราะพบเคสจริงที่ 429 ยังไม่หายหลัง retry แค่ 1 ครั้ง)
      const PUSH_RETRY_DELAYS_MS = [800, 1500]
      const pushWithRetry = async (messages: messagingApi.Message[]): Promise<void> => {
        const attempt = () =>
          Promise.race([
            lineClient.pushMessage({ to: userId, messages }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('push_timeout')), 4000)
            ),
          ])
        try {
          await attempt()
          return
        } catch (err) {
          if (!(err as Error).message?.includes('429')) throw err
          for (const delay of PUSH_RETRY_DELAYS_MS) {
            await new Promise((r) => setTimeout(r, delay))
            try {
              await attempt()
              return
            } catch (retryErr) {
              if (!(retryErr as Error).message?.includes('429')) throw retryErr
            }
          }
          throw new Error('429 - Too Many Requests (retry exhausted)')
        }
      }

      // safeReply: ป้องกัน lineClient.replyMessage hang → function ไม่ complete → Vercel 504
      // ห่อทั้งฟังก์ชันด้วย withUserSendLock — กันข้อความอื่นจากลูกค้าคนเดียวกันยิง API
      // แทรกกลางระหว่าง reply+fallback push ของข้อความนี้ (2026-08-05)
      const safeReply = async (messages: messagingApi.Message[]): Promise<void> => withUserSendLock(userId, async () => {
        try {
          await Promise.race([
            lineClient.replyMessage({ replyToken, messages }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('reply_timeout')), 4000)
            ),
          ])
          for (const m of messages)
            if (m.type === 'text' && 'text' in m)
              logChat({ userId, channel: 'LINE', role: 'bot', message: (m as { text: string }).text, ts: Date.now() })
        } catch (err) {
          log.warn('reply.send_failed', { userId, err: (err as Error).message })
          // replyToken อาจหมดอายุ/ถูกใช้ไปแล้ว (พบจริงจาก log: 400 Bad Request) — fallback ไป
          // pushMessage() ด้วย userId แทน ไม่ต้องพึ่ง replyToken เดิมที่มีปัญหา ลูกค้าจะยังได้รับคำตอบ
          try {
            await pushWithRetry(messages)
            for (const m of messages)
              if (m.type === 'text' && 'text' in m)
                logChat({ userId, channel: 'LINE', role: 'bot', message: (m as { text: string }).text, ts: Date.now() })
            log.info('reply.fallback_push_sent', { userId })
          } catch (pushErr) {
            log.error('reply.fallback_push_failed', { userId, err: (pushErr as Error).message })
            notifyAdmin(userId, '⚠️ ส่งข้อความหาลูกค้าไม่สำเร็จ (reply+push ล้มเหลวทั้งคู่) กรุณาติดต่อลูกค้าเองด้วยค่ะ').catch(() => {})
          }
        }
      })

      try {
        // --- SESSION GREETING — ทักทายครั้งแรก (24h) ---
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

        const txt = (text: string): messagingApi.Message[] => {
          const msgs: messagingApi.Message[] = []
          if (holidayNotice) msgs.push({ type: 'text', text: holidayNotice })
          msgs.push({ type: 'text', text })
          return msgs
        }

        // --- TEXT ---
        if (msgType === 'text') {
          const userMessage = (event.message as { text: string }).text
          log.info('webhook.message_received', { userId })
          logChat({ userId, channel: 'LINE', role: 'user', message: userMessage, ts: Date.now() })
          const history = await getHistory(userId)
          const handoffMsg = getHandoffMessage()

          // (เรื่องที่ 42, 2026-08-08) เดิมมีคำสั่ง "คืนบอท:{userId}" ให้แอดมินพิมพ์ปลด takeover เอง
          // แต่ไม่มีการตรวจสอบสิทธิ์ผู้ส่งเลย — ใครก็พิมพ์คุยกับบอทตรงๆ แล้วปลด takeover ของคนอื่นได้
          // ลบคำสั่งนี้ทิ้งทั้งหมด ใช้ TAKEOVER_TTL auto-expire เป็นทางออกทางเดียวแทน

          // ตรวจ schedule — ถ้าอยู่ในช่วงปิดบอท ไม่ตอบ (แอดมินดูแลเอง)
          // เก็บข้อความลูกค้าไว้ใน history เฉยๆ (ไม่ auto-reply) รอลูกค้าทักมาใหม่ตอนบอทเปิด — TTL
          // ยืดตามเวลาที่เหลือจริงจนกว่าตารางจะเปิดบอทอีกครั้ง แทน TTL ปกติ 10 นาที (เรื่องที่ 39, 2026-08-08)
          if (await isScheduledOff('line')) {
            const ttl = await computeOffHoursHistoryTtl('line')
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }], ttl)
            log.info('reply.scheduled_off', { userId, historyTtlSec: ttl })
            return
          }

          // ชั้น 2: rate limit — pipeline กัน TTL หาย
          try {
            const [rate] = await redis.pipeline()
              .incr(`msg_rate:${userId}`)
              .expire(`msg_rate:${userId}`, MSG_RATE_TTL)
              .exec() as [number, number]
            if (rate > MSG_RATE_LIMIT) {
              if (rate === MSG_RATE_LIMIT + 1) {
                await safeReply([{ type: 'text', text: 'รอสักครู่นะคะ น้องใจดีกำลังอ่านข้อความค่ะ 🙏' }])
                log.info('reply.rate_limit_warned', { userId, rate })
              } else {
                log.info('reply.rate_limited', { userId, rate })
              }
              return
            }
          } catch { /* Redis ล่ม — ข้าม */ }

          // ── ans: ส่ง greeting แยกก่อน (replyToken) แล้ว push คำตอบทีหลัง ──
          // ห่อด้วย withUserSendLock เหมือน safeReply (2026-08-05)
          const safePush = async (messages: messagingApi.Message[]): Promise<void> => withUserSendLock(userId, async () => {
            try {
              await pushWithRetry(messages)
              for (const m of messages)
                if (m.type === 'text' && 'text' in m)
                  logChat({ userId, channel: 'LINE', role: 'bot', message: (m as { text: string }).text, ts: Date.now() })
            } catch (err) {
              log.warn('push.send_failed', { userId, err: (err as Error).message })
              notifyAdmin(userId, '⚠️ ส่งข้อความหาลูกค้าไม่สำเร็จ (push ล้มเหลว) กรุณาติดต่อลูกค้าเองด้วยค่ะ').catch(() => {})
            }
          })
          let greetReplied = false
          const ans = async (msgs: messagingApi.Message[]): Promise<void> => {
            if (greetFirst && !greetReplied) {
              const gm: messagingApi.Message[] = []
              gm.push({ type: 'text', text: getWelcomeMessage() })
              await safeReply(gm)
              greetReplied = true
              await safePush(msgs)
            } else if (greetFirst) {
              await safePush(msgs)
            } else {
              await safeReply(msgs)
            }
          }

          // ส่งผ่าน push ตรงๆ เท่านั้น ข้าม replyMessage() ไปเลย — ใช้เฉพาะ branch ที่ประมวลผล
          // ช้า (วิเคราะห์รูปภาพ 7-15 วิ) เพราะ replyToken มีโอกาสหมดอายุสูงมากกว่าจะถึงจุดส่ง
          // (พบจริง: เคส 21:04 ใช้เวลา 14.5 วิ replyToken หมดอายุ 400 ก่อน push จะเริ่มด้วยซ้ำ)
          // เสียเวลาลอง reply ที่รู้อยู่แล้วว่าจะพังไปเปล่าๆ (2026-08-04)
          const pushOnly = async (text: string): Promise<void> => {
            const msgs: messagingApi.Message[] = []
            if (holidayNotice) msgs.push({ type: 'text', text: holidayNotice })
            if (greetFirst) msgs.push({ type: 'text', text: getWelcomeMessage() })
            msgs.push({ type: 'text', text })
            await safePush(msgs)
          }

          // ตรวจ pending image — ลูกค้าส่งรูปแล้วพิมพ์ข้อความตามมา
          // อ่านทั้ง list แทนตัวเดียว (เดิมอ่านแค่ img_data: ตัวเดียว ทำให้ส่งหลายรูปติดกัน
          // รูปแรกๆ หายไป เพราะถูกทับด้วยรูปหลังใน redis.set ก่อนจะถูกอ่าน) (2026-08-05)
          let imgList: { id: string; ts: number }[] = []
          try {
            const raw = await redis.lrange<string>(`img_list:${userId}`, 0, -1)
            imgList = raw.map(r => (typeof r === 'string' ? JSON.parse(r) : r) as { id: string; ts: number })
          } catch { /* Redis ล่ม */ }

          if (imgList.length > 0) {
            const elapsed = Date.now() - imgList[0].ts // นับจากรูปแรกที่ส่งมาในชุดนี้
            if (elapsed < 300000) {
              try { await redis.del(`img_list:${userId}`) } catch { /* */ }
              const blobClient = new messagingApi.MessagingApiBlobClient({
                channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
              })
              const base64Images: string[] = []
              for (const img of imgList) {
                const stream = await blobClient.getMessageContent(img.id)
                const chunks: Buffer[] = []
                for await (const chunk of stream) chunks.push(Buffer.from(chunk))
                base64Images.push(Buffer.concat(chunks).toString('base64'))
              }
              // อ่านรูป+ข้อความพร้อมกัน สรุป+ถามยืนยันก่อนเสมอ แทนตอบทันที (เดิมค้นเว็บอัตโนมัติ
              // ทุกครั้งผ่าน generateReplyWithImage() แม้คำถามไม่เกี่ยวกับสเปกสินค้าเลยก็ตาม)
              // เมื่อลูกค้ายืนยันแล้วข้อความตอบกลับจะเดินเข้า flow ข้อความปกติเอง (ค้นชีตก่อน) (2026-08-01)
              // timeout dynamic ตามจำนวนรูป: รูปแรก 15s + รูปที่เพิ่มมาอีกรูปละ 8s (2026-08-05)
              const dynamicTimeout = 15000 + 8000 * (base64Images.length - 1)
              const faqTextForImage = await fetchFAQ()
              const withTextResult = await Promise.race([
                analyzeImageWithText(base64Images, userMessage, faqTextForImage),
                new Promise<{ kind: 'unclear' }>((_, reject) =>
                  setTimeout(() => reject(new Error('gemini_timeout')), dynamicTimeout)
                ),
              ]).catch((err) => {
                log.error('gemini.image_text_failed', { err: (err as Error).message, userId, imageCount: base64Images.length })
                return { kind: 'unclear' as const }
              })

              if (withTextResult.kind === 'unclear') {
                await pushOnly(UNAVAILABLE_MSG)
                log.info('image_text.unclear', { userId, latencyMs: Date.now() - startTime, imageCount: base64Images.length })
                return
              }

              // ประเภท E (ข้อความ/แบบฟอร์ม/บทสนทนาบุคคลที่สาม) — handoff ทันที ไม่ผ่านขั้นยืนยัน
              // ไม่บันทึก history เป็น pending-confirm เพราะไม่ไหลเข้า protocol ไหนต่อ (2026-08-06)
              if (withTextResult.kind === 'handoff') {
                await pushOnly(IMAGE_HANDOFF_MSG)
                notifyAdmin(userId, '⚠️ ลูกค้าส่งรูปภาพที่มีข้อมูลบุคคลที่สาม (แบบฟอร์ม/บทสนทนา) รบกวนตรวจสอบและติดต่อลูกค้าเองด้วยค่ะ').catch(() => {})
                log.info('image_text.handoff', { userId, latencyMs: Date.now() - startTime, imageCount: base64Images.length })
                return
              }

              // ประเภท G (ใบเสร็จ/สลิปขนส่ง/หลักฐานโอนเงิน) หรือ F+ถามสต็อก — รับทราบ/ตอบทันที
              // แล้ว handoff เลย ไม่ผ่านขั้นยืนยัน ไม่บันทึก history เป็น pending-confirm
              // เพราะไม่ไหลเข้า protocol ไหนต่อ (2026-08-06, เรื่องที่ 34)
              if (withTextResult.kind === 'ackHandoff') {
                await pushOnly(withTextResult.message)
                notifyAdmin(userId, `⚠️ ลูกค้าส่งรูปภาพ/ข้อความที่ต้องรอแอดมินยืนยัน: ${withTextResult.message}`).catch(() => {})
                log.info('image_text.ack_handoff', { userId, latencyMs: Date.now() - startTime, imageCount: base64Images.length })
                return
              }

              await pushOnly(withTextResult.confirmMessage)
              await saveHistory(userId, [...history, { role: 'user', text: `[รูปภาพ+ข้อความ] ${withTextResult.summary}` }, { role: 'model', text: withTextResult.confirmMessage }])
              log.info('image_text.confirm_sent', { userId, latencyMs: Date.now() - startTime, imageCount: base64Images.length })
              return
            } else {
              // เกิน 5 นาที → วิเคราะห์รูปก่อน บันทึก context → แสดง card / ถามยืนยัน / ถามชื่อรุ่น
              try { await redis.del(`img_list:${userId}`) } catch { /* */ }

              let intent: Awaited<ReturnType<typeof analyzeImageIntent>> = { kind: 'unclear' }

              try {
                const blobClient2 = new messagingApi.MessagingApiBlobClient({
                  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
                })
                const base64Images2: string[] = []
                for (const img of imgList) {
                  const stream2 = await blobClient2.getMessageContent(img.id)
                  const chunks2: Buffer[] = []
                  for await (const chunk of stream2) chunks2.push(Buffer.from(chunk))
                  base64Images2.push(Buffer.concat(chunks2).toString('base64'))
                }
                intent = await analyzeImageIntent(base64Images2)
                log.info('image.intent_analyzed', { userId, kind: intent.kind, imageCount: base64Images2.length })
              } catch { /* วิเคราะห์ล้มเหลว — ข้ามได้ */ }

              if (intent.kind === 'unclear') {
                await ans(txt('รบกวนพิมพ์ชื่อรุ่นที่สนใจได้ไหมคะ จะได้ช่วยหาข้อมูลให้ถูกต้องค่ะ'))
                log.info('image.ocr_not_found', { userId, elapsedMs: elapsed })
                return
              }

              // ประเภท E (ข้อความ/แบบฟอร์ม/บทสนทนาบุคคลที่สาม) — handoff ทันที ไม่ผ่านขั้นยืนยัน (2026-08-06)
              if (intent.kind === 'handoff') {
                await ans(txt(IMAGE_HANDOFF_MSG))
                notifyAdmin(userId, '⚠️ ลูกค้าส่งรูปภาพที่มีข้อมูลบุคคลที่สาม (แบบฟอร์ม/บทสนทนา) รบกวนตรวจสอบและติดต่อลูกค้าเองด้วยค่ะ').catch(() => {})
                log.info('image.intent_handoff', { userId, elapsedMs: elapsed })
                return
              }

              // ประเภท G (ใบเสร็จ/สลิปขนส่ง/หลักฐานโอนเงิน) — รับทราบทันที+handoff ไม่ผ่านขั้นยืนยัน (2026-08-06, เรื่องที่ 34)
              if (intent.kind === 'ackHandoff') {
                await ans(txt(intent.message))
                notifyAdmin(userId, `⚠️ ลูกค้าส่งรูปภาพที่ต้องรอแอดมินยืนยัน: ${intent.message}`).catch(() => {})
                log.info('image.intent_ack_handoff', { userId, elapsedMs: elapsed })
                return
              }

              if (intent.kind === 'other') {
                await saveHistory(userId, [...history, { role: 'user', text: `[ลูกค้าส่งรูปภาพ: ${intent.summary}]` }, { role: 'model', text: intent.confirmMessage }])
                await ans(txt(intent.confirmMessage))
                log.info('image.intent_confirm_sent', { userId, elapsedMs: elapsed })
                return
              }

              await saveHistory(userId, [...history, { role: 'user', text: `[ลูกค้าส่งรูปภาพสินค้า: ${intent.product}]` }, { role: 'model', text: '[แสดงเมนูตัวเลือก]' }])
              await ans([imageIntentCard(intent.product) as messagingApi.Message])
              log.info('image.intent_card_sent_delayed', { userId, elapsedMs: elapsed })
              return
            }
          }

          // ลูกค้ากด "สอบถามสเปก" จาก imageIntentCard — อ่านจาก img_list: เอารูปล่าสุด
          // (ตัวเดียวพอ เพราะ generateReplyWithImage() ยังเป็นฟังก์ชันรูปเดี่ยวเดิม ไม่แตะ) (2026-08-05)
          if (userMessage === 'สอบถามสเปก') {
            let imageId: string | null = null
            try {
              const raw = await redis.lrange<string>(`img_list:${userId}`, -1, -1)
              if (raw.length) {
                const last = (typeof raw[0] === 'string' ? JSON.parse(raw[0]) : raw[0]) as { id: string; ts: number }
                imageId = last.id
              }
              await redis.del(`img_list:${userId}`)
            } catch { /* Redis ล่ม — ตกลงไป FAQ flow ปกติ */ }

            if (imageId) {
              const blobClient = new messagingApi.MessagingApiBlobClient({
                channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
              })
              const stream = await blobClient.getMessageContent(imageId)
              const chunks: Buffer[] = []
              for await (const chunk of stream) chunks.push(Buffer.from(chunk))
              const imageBuffer = Buffer.concat(chunks)
              const base64Image = imageBuffer.toString('base64')
              log.info('image_spec.downloaded', { userId, sizeBytes: imageBuffer.length })

              const faqText = await fetchFAQ()
              const reply = await Promise.race([
                generateReplyWithImage(base64Image, faqText, 'สอบถามสเปกและฟังก์ชันการใช้งาน', 'line'),
                new Promise<string>((_, reject) =>
                  setTimeout(() => reject(new Error('gemini_timeout')), 15000)
                ),
              ]).catch((err) => {
                log.error('gemini.image_spec_failed', { err: (err as Error).message, userId })
                return UNAVAILABLE_MSG
              })

              await ans(txt(reply))
              log.info('image_spec_reply.sent', { userId, latencyMs: Date.now() - startTime })
              return
            }
          }

          // Admin Takeover — เงียบถ้าแอดมินกำลังดูแลอยู่
          try {
            const takeover = await redis.get(`takeover:${userId}`)
            if (takeover) {
              log.info('reply.takeover_suppressed', { userId })
              return
            }
          } catch { /* Redis ล่ม — ข้าม */ }

          // ตรวจ pre-handoff state
          let pendingTrigger: string | null = null
          try {
            pendingTrigger = await redis.getdel<string>(`pre_handoff:${userId}`)
          } catch { /* Redis ล่ม — ข้าม */ }

          if (pendingTrigger !== null) {
            // (เรื่องที่ 42) ไม่ notifyAdmin() อีกต่อไปสำหรับ pre-handoff trigger — แอดมินเช็คแชท
            // เองเป็นปกติอยู่แล้ว เหมือนที่ตัดสินใจไว้กับ HANDOFF sentinel (เรื่องที่ 37) และ Type D
            // fallback ฝั่งรูปภาพ (เรื่องที่ 35) — ให้สม่ำเสมอกันทั้งหมด redis state ยังคงเดิมทุกประการ
            try {
              await Promise.all([
                redis.set(`routed:${userId}`, '1', { ex: 300 }),
                redis.set(`takeover:${userId}`, '1', { ex: TAKEOVER_TTL }),
                redis.del(`handoff_notified:${userId}`),
              ])
            } catch (stateErr) {
              log.error('handoff.state_failed', { err: (stateErr as Error).message, userId })
            }
            await ans(txt(handoffMsg))
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
            log.info('handoff.after_pre_handoff', { userId, latencyMs: Date.now() - startTime })
            return
          }

          // "ขอเจ้าของ" นอกเวลาทำการ — ไม่ handoff เลย ตอบข้อความนอกเวลาแทน
          if (isOwnerRequest(userMessage) && (thaiHour >= 18 || thaiHour < 8)) {
            await ans(txt(OWNER_REQUEST_OFF_HOURS_MSG))
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: OWNER_REQUEST_OFF_HOURS_MSG }])
            log.info('handoff.owner_request_off_hours', { userId })
            return
          }

          if (shouldHandoffImmediate(userMessage) || isOwnerRequest(userMessage)) {
            let alreadyRouted = false
            try {
              alreadyRouted = !!(await redis.get(`routed:${userId}`))
            } catch { /* Redis ล่ม */ }

            if (alreadyRouted) {
              try {
                const [count] = await redis.pipeline()
                  .incr(`handoff_notified:${userId}`)
                  .expire(`handoff_notified:${userId}`, 10 * 60)
                  .exec() as [number, number]
                if (count === 1) {
                  await ans(txt('แอดมินจะติดต่อกลับในเวลาทำการนะคะ 🙏\n🕐 เวลาทำการ 08:00–17:00 น. (จันทร์–เสาร์)'))
                  log.info('handoff.already_routed_ack', { userId })
                } else {
                  log.info('handoff.already_routed_silent', { userId, count })
                }
              } catch { /* Redis ล่ม */ }
              return
            }

            try {
              await redis.set(`pre_handoff:${userId}`, userMessage, { ex: PRE_HANDOFF_TTL })
            } catch {
              log.warn('handoff.pre_handoff_save_failed', { userId })
            }
            const preHandoffQ = 'กรุณาแจ้งรายละเอียดที่ต้องการให้แอดมินช่วยด้วยนะคะ เพื่อให้ดูแลได้ถูกต้องค่ะ'
            await ans(txt(preHandoffQ))
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: preHandoffQ }])
            log.info('handoff.pre_handoff_question', { userId, latencyMs: Date.now() - startTime })
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
                await ans(txt(reminder))
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reminder }])
                log.info('reply.duplicate_reminded', { userId })
              } else {
                log.info('reply.duplicate_suppressed', { userId, repeatCount })
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
            await ans(txt(exactMatch))
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: exactMatch }])
            log.info('exact_match.sent', { userId, latencyMs: Date.now() - startTime })
            return
          }

          // ลูกค้ายืนยันสั่งซื้อ — ตอบตามเวลาทำการ ไม่ผ่าน Gemini
          if (ORDER_CONFIRM_RE.test(userMessage)) {
            const isOffHours = thaiHour >= 18 || thaiHour < 8
            if (isOffHours) {
              await ans(txt(ORDER_CONFIRM_OFF_HOURS_MSG))
              await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: ORDER_CONFIRM_OFF_HOURS_MSG }])
              log.info('order_confirm.off_hours', { userId })
              return
            }

            let alreadyReplied = false
            try {
              alreadyReplied = !!(await redis.get(`order_confirm:${userId}`))
            } catch { /* Redis ล่ม */ }

            if (alreadyReplied) {
              log.info('order_confirm.suppressed', { userId })
              return
            }

            try {
              await redis.set(`order_confirm:${userId}`, '1', { ex: ORDER_CONFIRM_TTL })
            } catch { /* Redis ล่ม */ }
            await ans(txt(ORDER_CONFIRM_WAIT_MSG))
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: ORDER_CONFIRM_WAIT_MSG }])
            log.info('order_confirm.wait_reply', { userId })
            return
          }

          const faqText = await fetchFAQ()
          const geminiController = new AbortController()
          const geminiTimeoutId = setTimeout(() => geminiController.abort(), 20000)
          const reply = await generateReply(userMessage, faqText, history, handoffMsg, 'line', geminiController.signal)
            .catch((err) => {
              log.error('gemini.failed', { err: (err as Error).message })
              return GEMINI_UNAVAILABLE
            })
          clearTimeout(geminiTimeoutId)

          // Gemini ไม่ตอบทัน (timeout, 429, 503) — แจ้งลูกค้าให้ถามใหม่
          if (reply === GEMINI_UNAVAILABLE) {
            await ans(txt(UNAVAILABLE_MSG))
            log.info('reply.gemini_unavailable', { userId })
            return
          }

          // CANCEL_IMEI
          if (reply === 'CANCEL_IMEI') {
            const cancelMsg = 'ยกเลิกรายการแล้วค่ะ มีอะไรให้น้องใจดีช่วยอีกไหมคะ'
            await ans(txt(cancelMsg))
            await saveHistory(userId, [])
            log.info('imei.cancelled', { userId })
            return
          }

          // HANDOFF
          // ค้นหา "HANDOFF:" ที่ไหนก็ได้ในข้อความ (ไม่ anchor ที่ต้น) เพราะ Gemini บางครั้งใส่ประโยค
          // นำหน้ามาก่อน "HANDOFF:" ทั้งที่ prompt สั่งห้ามไว้ — เดิมใช้ startsWith('HANDOFF') ทำให้เคส
          // แบบนี้หลุดไปทั้งก้อน (ข้อความดิบ + "HANDOFF: ...") ให้ลูกค้าเห็นตรงๆ แทนที่จะถูกแทนด้วย
          // handoffMsg (เจอบั๊กจริงจาก screenshot ลูกค้า 2026-08-07)
          if (reply === 'HANDOFF' || reply.toUpperCase().includes('HANDOFF:')) {
            const summary = reply.replace(/^[\s\S]*?HANDOFF:?\s*/i, '').trim() || 'ลูกค้าต้องการติดต่อแอดมิน'
            // self_repair_protocol ส่ง "...HANDOFF: ขอวิธีทำเอง | ..." มาเฉพาะกรณีถามวิธีทำเอง (ไม่ใช่แจ้งเครื่องเสีย)
            // ค้นหาทั้งข้อความเช่นกัน ไม่ anchor ที่ต้น
            const replyMsg = /HANDOFF:\s*ขอวิธีทำเอง/i.test(reply)
              ? 'กรุณารอเจ้าหน้าที่เพื่อทำการตรวจสอบและแนะนำวิธีให้อีกครั้งนะคะ'
              : handoffMsg
            // (เรื่องที่ 37) ไม่ notifyAdmin() อีกต่อไปสำหรับ handoff ข้อความล้วน — แอดมินเช็คแชทเองเป็นปกติ
            // อยู่แล้ว เหมือนที่ตัดสินใจไว้กับ Type D fallback ฝั่งรูปภาพ (เรื่องที่ 35) — notifyAdmin() เอง
            // ยังไม่ได้แตะ ยังใช้อยู่ที่ Type E/G/F+สต็อก ฝั่งรูปภาพตามปกติ (line 313/323/362/370)
            try {
              await Promise.all([
                redis.set(`routed:${userId}`, '1', { ex: 300 }),
                redis.set(`takeover:${userId}`, '1', { ex: TAKEOVER_TTL }),
                redis.del(`handoff_notified:${userId}`),
              ])
            } catch (stateErr) {
              log.error('handoff.state_failed', { err: (stateErr as Error).message, userId })
            }
            await ans(txt(replyMsg))
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: replyMsg }])
            log.info('handoff.imei_confirmed', { userId, latencyMs: Date.now() - startTime, summary })
            return
          }

          // ชั้น 3: out-of-domain/nonsense — pipeline กัน TTL หาย
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
              await ans(txt(OUT_OF_DOMAIN_MSG))
              await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: OUT_OF_DOMAIN_MSG }])
              log.info('reply.out_of_domain', { userId })
            } else {
              log.info('reply.nonsense_suppressed', { userId, nonsenseCount })
            }
            return
          }

          // retry logic
          if (reply === NOT_FOUND) {
            // ค้นชีต + ค้นเว็บไม่เจอ (NOT_FOUND) + ข้อความมี deferred handoff trigger
            // → ขอรายละเอียดก่อน 1 รอบแล้วค่อย handoff (ข้าม retry 2 รอบปกติ)
            if (shouldHandoffDeferred(userMessage)) {
              try {
                await redis.set(`pre_handoff:${userId}`, userMessage, { ex: PRE_HANDOFF_TTL })
              } catch {
                log.warn('handoff.pre_handoff_save_failed', { userId })
              }
              const preHandoffQ = 'กรุณาแจ้งรายละเอียดที่ต้องการให้แอดมินช่วยด้วยนะคะ เพื่อให้ดูแลได้ถูกต้องค่ะ'
              await ans(txt(preHandoffQ))
              await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: preHandoffQ }])
              log.info('handoff.deferred_after_not_found', { userId, latencyMs: Date.now() - startTime })
              return
            }

            try {
              const retryKey = `retry:${userId}`
              const hasRetried = await redis.get(retryKey)
              if (hasRetried) {
                await redis.del(retryKey)
                await ans(txt(handoffMsg))
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
                log.info('retry.admin_routed', { userId })
              } else {
                await redis.set(retryKey, '1', { ex: RETRY_TTL })
                const retryMsg = 'ขออภัยค่ะ ไม่พบข้อมูลในระบบ สามารถติดต่อแอดมินหรือช่างเทคนิคได้ในเวลาทำการ 08:00–17:00 น. ค่ะ หรือลองอธิบายเพิ่มเติมได้เลยนะคะ'
                await ans(txt(retryMsg))
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: retryMsg }])
                log.info('retry.first_attempt', { userId })
                try {
                  await redis.lpush(`unanswered_log`, JSON.stringify({
                    ts: new Date().toISOString(), userId, question: userMessage,
                  }))
                  await redis.ltrim(`unanswered_log`, 0, 499)
                } catch { /* Redis ล่ม — ข้าม */ }
              }
            } catch {
              await ans(txt(handoffMsg))
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

          await ans(txt(finalReply))
          await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: finalReply }])
          log.info('reply.sent', { userId, latencyMs: Date.now() - startTime, replyLength: finalReply.length })
          try { await redis.zincrby('question_freq', 1, userMessage.slice(0, 100)) } catch { /* Redis ล่ม */ }
        }

        // --- IMAGE ---
        if (msgType === 'image') {
          // บันทึกฝั่งลูกค้าไว้ก่อน isScheduledOff() check เสมอ (ไม่ว่าบอทเปิดหรือปิด) ให้แอดมิน
          // เห็นในหน้าประวัติแชทว่าลูกค้าส่งรูปมา — คำตอบบอทไม่ต้อง log ซ้ำตรงนี้ เพราะ safeReply()/
          // safePush() ที่ทุกจุดตอบใน branch นี้ใช้อยู่แล้ว log ฝั่งบอทให้อัตโนมัติหลังส่งสำเร็จ
          // (เรื่องที่ 40, 2026-08-08)
          logChat({ userId, channel: 'LINE', role: 'user', message: '[ลูกค้าส่งรูปภาพ]', ts: Date.now() })

          // ตรวจ schedule — ถ้าอยู่ในช่วงปิดบอท ไม่ตอบ (แอดมินดูแลเอง)
          // (เดิม branch นี้ลืมเช็ค ทำให้บอทตอบรูปภาพได้แม้ตั้งเวลาปิดไว้)
          // เก็บไว้ใน history เฉยๆ (ไม่วิเคราะห์รูป/ไม่ auto-reply) รอลูกค้าทักมาใหม่ตอนบอทเปิด — TTL
          // ยืดตามเวลาที่เหลือจริงจนกว่าตารางจะเปิดบอทอีกครั้ง เหมือน TEXT branch (เรื่องที่ 39, 2026-08-08)
          if (await isScheduledOff('line')) {
            const imgHistory = await getHistory(userId)
            const ttl = await computeOffHoursHistoryTtl('line')
            await saveHistory(userId, [...imgHistory, { role: 'user', text: '[ลูกค้าส่งรูปภาพ]' }], ttl)
            log.info('image.scheduled_off', { userId, historyTtlSec: ttl })
            return
          }

          const imageId = (event.message as { id: string }).id
          let savedToRedis = false

          // เก็บเป็น list แทน key เดี่ยว (เดิม redis.set ทับกันทุกครั้ง ทำให้ส่งหลายรูปติดกัน
          // รูปแรกๆ หายไปจากการวิเคราะห์ เหลือแค่รูปล่าสุด) — reset TTL 300s ทุกครั้งที่มีรูปใหม่
          // เข้ามา + จำกัดไม่เกิน 5 รูปล่าสุดกันรายการยาวเกินไป (2026-08-05)
          try {
            await redis.rpush(`img_list:${userId}`, JSON.stringify({ id: imageId, ts: Date.now() }))
            await Promise.all([
              redis.ltrim(`img_list:${userId}`, -5, -1),
              redis.expire(`img_list:${userId}`, 300),
            ])
            savedToRedis = true
            log.info('image.received_waiting', { userId, imageId })
          } catch { /* Redis ล่ม */ }

          if (savedToRedis) {
            if (greetFirst) {
              await safeReply([{ type: 'text', text: getWelcomeMessage() }])
            }
            log.info('image.received_ack', { userId, imageId })
          } else {
            const fallbackMsgs: messagingApi.Message[] = []
            if (greetFirst) fallbackMsgs.push({ type: 'text', text: getWelcomeMessage() })
            fallbackMsgs.push(imageIntentCard() as messagingApi.Message)
            await safeReply(fallbackMsgs)
            log.info('image.intent_card_sent_fallback', { userId, imageId })
          }
        }

      } catch (err) {
        log.error('webhook.error', { err: (err as Error).message, userId })
        await safeReply([{ type: 'text', text: DEFAULT_REPLY }])
      }
    })
  )

  return NextResponse.json({ ok: true })
}
