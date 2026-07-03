import { NextRequest, NextResponse } from 'next/server'
import { validateSignature, messagingApi } from '@line/bot-sdk'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply, generateReplyWithImage } from '@/lib/gemini'
import { shouldHandoffImmediate, shouldHandoffDeferred, isOwnerRequest, OWNER_REQUEST_OFF_HOURS_MSG, notifyAdmin } from '@/lib/handoff'
import { log } from '@/lib/log'
import { redis } from '@/lib/redis'
import { imageIntentCard } from '@/lib/flex-cards'
import { getHistory, saveHistory } from '@/lib/history'
import { isScheduledOff } from '@/lib/schedule'
import { shouldGreet, WELCOME_MSG } from '@/lib/greeting'
import { logChat } from '@/lib/chatlog'

const NOT_FOUND = '[NOT_FOUND]'
const GEMINI_UNAVAILABLE = '[GEMINI_UNAVAILABLE]'
const UNAVAILABLE_MSG = 'ขออภัยค่ะ ระบบกำลังประมวลผลนานกว่าปกติ 🙏\nแอดมินจะรีบตอบกลับในเวลาทำการ 08:00–17:00 น. นะคะ'
const TAKEOVER_TTL = 2 * 3600
const OUT_OF_DOMAIN = '[OUT_OF_DOMAIN]'
const OUT_OF_DOMAIN_MSG = 'น้องใจดีเป็นผู้ช่วยด้านวิทยุสื่อสารเท่านั้นค่ะ ต้องการสอบถามข้อมูลวิทยุสื่อสารรุ่นไหนคะ'
const RETRY_TTL = 600
const PRE_HANDOFF_TTL = 600
const OFF_HOURS_TTL = 23 * 3600
const LAST_ANSWER_TTL = 2 * 60
const MSG_RATE_TTL = 10
const MSG_RATE_LIMIT = 5
const NONSENSE_TTL = 10 * 60

const OFF_HOURS_NOTICE =
  'ขณะนี้อยู่นอกเวลาทำการ แอดมินจะตอบกลับในเวลาทำการ 08:00–17:00 น. ค่ะ 🙏\nระหว่างนี้น้องใจดีช่วยดูแลก่อนนะคะ'

function getHandoffMessage(): string {
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  return thaiHour >= 18 || thaiHour < 8
    ? 'ขณะนี้อยู่นอกเวลาทำการ รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานให้บริการในเวลาทำการ 08:00–17:00 น. ค่ะ'
    : 'รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานกำลังดูแลท่านอยู่ค่ะ'
}

export const runtime = 'nodejs'
export const maxDuration = 30

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

      const msgType = (event.message as { type: string }).type
      const replyToken = event.replyToken as string
      const source = event.source as { type: string; userId?: string }
      const userId = source.userId ?? 'unknown'
      const startTime = Date.now()

      const lineClient = new messagingApi.MessagingApiClient({
        channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
      })

      // safeReply: ป้องกัน lineClient.replyMessage hang → function ไม่ complete → Vercel 504
      const safeReply = async (messages: messagingApi.Message[]): Promise<void> => {
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
        }
      }

      try {
        // --- SESSION GREETING — off-hours notice + ทักทายครั้งแรก (24h) ---
        let offHoursNotice: string | null = null
        const thaiHour = (new Date().getUTCHours() + 7) % 24

        if (thaiHour >= 18 || thaiHour < 8) {
          try {
            const alreadyNotified = await redis.get(`off_hours:${userId}`)
            if (!alreadyNotified) {
              await redis.set(`off_hours:${userId}`, '1', { ex: OFF_HOURS_TTL })
              offHoursNotice = OFF_HOURS_NOTICE
            }
          } catch { /* Redis ล่ม — ข้าม */ }
        }

        const greetFirst = await shouldGreet(userId)

        const txt = (text: string): messagingApi.Message[] => {
          const msgs: messagingApi.Message[] = []
          if (offHoursNotice && !greetFirst) msgs.push({ type: 'text', text: offHoursNotice })
          msgs.push({ type: 'text', text })
          return msgs
        }

        // --- TEXT ---
        if (msgType === 'text') {
          const userMessage = (event.message as { text: string }).text
          logChat({ userId, channel: 'LINE', role: 'user', message: userMessage, ts: Date.now() })
          const history = await getHistory(userId)
          const handoffMsg = getHandoffMessage()

          // Admin release takeover
          if (userMessage.startsWith('คืนบอท:')) {
            const targetId = userMessage.slice('คืนบอท:'.length).trim()
            if (targetId) {
              try { await redis.del(`takeover:${targetId}`) } catch { /* Redis ล่ม */ }
              await safeReply([{ type: 'text', text: `✅ คืนน้องใจดีดูแลลูกค้าแล้วค่ะ (${targetId.slice(-6)})` }])
              log.info('takeover.released', { by: userId, target: targetId })
              return
            }
          }

          // ตรวจ schedule — ถ้าอยู่ในช่วงปิดบอท ไม่ตอบ (แอดมินดูแลเอง)
          if (await isScheduledOff('line')) {
            log.info('reply.scheduled_off', { userId })
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
          const safePush = async (messages: messagingApi.Message[]): Promise<void> => {
            try {
              await Promise.race([
                lineClient.pushMessage({ to: userId, messages }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('push_timeout')), 4000)
                ),
              ])
              for (const m of messages)
                if (m.type === 'text' && 'text' in m)
                  logChat({ userId, channel: 'LINE', role: 'bot', message: (m as { text: string }).text, ts: Date.now() })
            } catch (err) {
              log.warn('push.send_failed', { userId, err: (err as Error).message })
            }
          }
          let greetReplied = false
          const ans = async (msgs: messagingApi.Message[]): Promise<void> => {
            if (greetFirst && !greetReplied) {
              const gm: messagingApi.Message[] = []
              if (offHoursNotice) gm.push({ type: 'text', text: offHoursNotice })
              gm.push({ type: 'text', text: WELCOME_MSG })
              await safeReply(gm)
              greetReplied = true
              await safePush(msgs)
            } else if (greetFirst) {
              await safePush(msgs)
            } else {
              await safeReply(msgs)
            }
          }

          // ตรวจ pending image — ลูกค้าส่งรูปแล้วพิมพ์ข้อความตามมา
          let imgData: { id: string; ts: number } | null = null
          try {
            const raw = await redis.get<string>(`img_data:${userId}`)
            if (raw) imgData = JSON.parse(raw) as { id: string; ts: number }
          } catch { /* Redis ล่ม */ }

          if (imgData) {
            const elapsed = Date.now() - imgData.ts
            if (elapsed < 300000) {
              try { await redis.del(`img_data:${userId}`) } catch { /* */ }
              const blobClient = new messagingApi.MessagingApiBlobClient({
                channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
              })
              const stream = await blobClient.getMessageContent(imgData.id)
              const chunks: Buffer[] = []
              for await (const chunk of stream) chunks.push(Buffer.from(chunk))
              const base64Image = Buffer.concat(chunks).toString('base64')
              const faqText = await fetchFAQ()
              const reply = await Promise.race([
                generateReplyWithImage(base64Image, faqText, userMessage),
                new Promise<string>((_, reject) =>
                  setTimeout(() => reject(new Error('gemini_timeout')), 15000)
                ),
              ]).catch((err) => {
                log.error('gemini.image_text_failed', { err: (err as Error).message, userId })
                return UNAVAILABLE_MSG
              })
              await ans(txt(reply))
              await saveHistory(userId, [...history, { role: 'user', text: `[รูปภาพ] ${userMessage}` }, { role: 'model', text: reply }])
              log.info('image_text_reply.sent', { userId, latencyMs: Date.now() - startTime })
              return
            } else {
              // เกิน 5 นาที → OCR รูปก่อน บันทึก context → แสดง card หรือถามชื่อรุ่น
              try { await redis.del(`img_data:${userId}`) } catch { /* */ }

              let ocrProduct: string | null = null

              try {
                const blobClient2 = new messagingApi.MessagingApiBlobClient({
                  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
                })
                const stream2 = await blobClient2.getMessageContent(imgData.id)
                const chunks2: Buffer[] = []
                for await (const chunk of stream2) chunks2.push(Buffer.from(chunk))
                const b64 = Buffer.concat(chunks2).toString('base64')
                const { GoogleGenAI } = await import('@google/genai')
                const ai2 = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })
                const ocrRes = await ai2.models.generateContent({
                  model: 'gemini-2.5-flash',
                  contents: [{ role: 'user', parts: [
                    { text: 'ระบุยี่ห้อและรุ่นสินค้าในรูปนี้ ตอบสั้นๆ เช่น "Spender TC-4M" ถ้าไม่เจอตอบว่า "ไม่ระบุ"' },
                    { inlineData: { mimeType: 'image/jpeg', data: b64 } },
                  ]}],
                  config: { maxOutputTokens: 50, temperature: 0 },
                })
                ocrProduct = ocrRes.text?.trim() || 'ไม่ระบุ'
                await saveHistory(userId, [...history, { role: 'user', text: `[ลูกค้าส่งรูปภาพสินค้า: ${ocrProduct}]` }, { role: 'model', text: '[แสดงเมนูตัวเลือก]' }])
                log.info('image.ocr_saved', { userId, product: ocrProduct })
              } catch { /* OCR ล้มเหลว — ข้ามได้ */ }

              if (ocrProduct === 'ไม่ระบุ') {
                await ans(txt('รบกวนพิมพ์ชื่อรุ่นที่สนใจได้ไหมคะ จะได้ช่วยหาข้อมูลให้ถูกต้องค่ะ'))
                log.info('image.ocr_not_found', { userId, elapsedMs: elapsed })
                return
              }

              await ans([
                ...(offHoursNotice && !greetFirst ? [{ type: 'text' as const, text: offHoursNotice }] : []),
                imageIntentCard(ocrProduct ?? undefined) as messagingApi.Message,
              ])
              log.info('image.intent_card_sent_delayed', { userId, elapsedMs: elapsed })
              return
            }
          }

          // ลูกค้ากด "สอบถามสเปก" จาก imageIntentCard
          if (userMessage === 'สอบถามสเปก') {
            let imageId: string | null = null
            try {
              imageId = await redis.get<string>(`img:${userId}`)
              if (imageId) await redis.del(`img:${userId}`)
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
                generateReplyWithImage(base64Image, faqText, 'สอบถามสเปกและฟังก์ชันการใช้งาน'),
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
            try {
              await Promise.all([
                redis.set(`routed:${userId}`, '1', { ex: 300 }),
                redis.set(`takeover:${userId}`, '1', { ex: TAKEOVER_TTL }),
                redis.del(`handoff_notified:${userId}`),
              ])
              await notifyAdmin(userId, `[เรื่องที่ต้องการ]: ${pendingTrigger}\n[รายละเอียด]: ${userMessage}`)
            } catch (notifyErr) {
              log.error('handoff.notify_failed', { err: (notifyErr as Error).message, userId })
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

          const faqText = await fetchFAQ()
          const reply = await Promise.race([
            generateReply(userMessage, faqText, history, handoffMsg),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('gemini_timeout')), 10000)
            ),
          ]).catch((err) => {
            log.error('gemini.failed', { err: (err as Error).message })
            return GEMINI_UNAVAILABLE
          })

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
          if (reply === 'HANDOFF' || reply.toUpperCase().startsWith('HANDOFF')) {
            const summary = reply.replace(/^HANDOFF[:\s]*/i, '').trim() || 'ลูกค้าต้องการติดต่อแอดมิน'
            try {
              await Promise.all([
                redis.set(`routed:${userId}`, '1', { ex: 300 }),
                redis.set(`takeover:${userId}`, '1', { ex: TAKEOVER_TTL }),
                redis.del(`handoff_notified:${userId}`),
              ])
              await notifyAdmin(userId, `[สรุปคำสั่ง]: ${summary}`)
            } catch (notifyErr) {
              log.error('handoff.notify_failed', { err: (notifyErr as Error).message, userId })
            }
            await ans(txt(handoffMsg))
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
            log.info('handoff.imei_confirmed', { userId, latencyMs: Date.now() - startTime, summary })
            return
          }

          // ชั้น 3: out-of-domain/nonsense — pipeline กัน TTL หาย
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
                await ans(txt(reminder))
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reminder }])
                log.info('reply.duplicate_reminded', { userId })
              } else {
                log.info('reply.duplicate_suppressed', { userId, repeatCount })
              }
              return
            }
            await redis.set(`last_answer:${userId}`, reply, { ex: LAST_ANSWER_TTL })
            await redis.del(`repeat_count:${userId}`)
          } catch { /* Redis ล่ม — ส่งปกติ */ }

          await ans(txt(reply))
          await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reply }])
          log.info('reply.sent', { userId, latencyMs: Date.now() - startTime, replyLength: reply.length })
          try { await redis.zincrby('question_freq', 1, userMessage.slice(0, 100)) } catch { /* Redis ล่ม */ }
        }

        // --- IMAGE ---
        if (msgType === 'image') {
          const imageId = (event.message as { id: string }).id
          let savedToRedis = false

          try {
            await Promise.all([
              redis.set(`img:${userId}`, imageId, { ex: 300 }),
              redis.set(`img_data:${userId}`, JSON.stringify({ id: imageId, ts: Date.now() }), { ex: 360 }),
            ])
            savedToRedis = true
            log.info('image.received_waiting', { userId, imageId })
          } catch { /* Redis ล่ม */ }

          if (savedToRedis) {
            const ackMsgs: messagingApi.Message[] = []
            if (offHoursNotice) ackMsgs.push({ type: 'text', text: offHoursNotice })
            if (greetFirst) ackMsgs.push({ type: 'text', text: WELCOME_MSG })
            ackMsgs.push({ type: 'text', text: 'ได้รับรูปแล้วค่ะ กำลังดูให้นะคะ 📷' })
            await safeReply(ackMsgs)
            log.info('image.received_ack', { userId, imageId })
          } else {
            const fallbackMsgs: messagingApi.Message[] = []
            if (offHoursNotice) fallbackMsgs.push({ type: 'text', text: offHoursNotice })
            if (greetFirst) fallbackMsgs.push({ type: 'text', text: WELCOME_MSG })
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
