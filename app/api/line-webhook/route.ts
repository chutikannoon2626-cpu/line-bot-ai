import { NextRequest, NextResponse } from 'next/server'
import { validateSignature, messagingApi } from '@line/bot-sdk'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply, generateReplyWithImage } from '@/lib/gemini'
import { shouldHandoff, notifyAdmin } from '@/lib/handoff'
import { log } from '@/lib/log'
import { redis } from '@/lib/redis'
import { imageIntentCard, greetingCard } from '@/lib/flex-cards'
import { getHistory, saveHistory } from '@/lib/history'

const NOT_FOUND = '[NOT_FOUND]'
const GREETING_MSG = 'Spenderclub ยินดีให้บริการค่ะ มีอะไรให้น้องใจดีช่วยบอกได้เลยนะคะ'
const GREETING_KEYWORDS = ['สวัสดี', 'หวัดดี', 'ดีจ้า']
const GREETING_TTL = 24 * 3600   // 24 ชั่วโมง
const TAKEOVER_TTL = 2 * 3600    // 2 ชั่วโมง — แอดมิน takeover
const OUT_OF_DOMAIN = '[OUT_OF_DOMAIN]'
const OUT_OF_DOMAIN_MSG = 'น้องใจดีเป็นผู้ช่วยด้านวิทยุสื่อสารเท่านั้นค่ะ ต้องการสอบถามข้อมูลวิทยุสื่อสารรุ่นไหนคะ'
const RETRY_TTL = 600           // 10 นาที
const PRE_HANDOFF_TTL = 600     // 10 นาที
const OFF_HOURS_TTL = 23 * 3600 // 23 ชั่วโมง — แจ้งซ้ำได้หลัง off-hours รอบถัดไป
const IN_HOURS_TTL = 23 * 3600  // 23 ชั่วโมง — ทักทายซ้ำได้หลัง business hours รอบถัดไป
const OUT_OF_DOMAIN_TTL = 24 * 3600 // 24 ชั่วโมง — ไม่ตอบซ้ำประโยคเดิม

const OFF_HOURS_NOTICE =
  'ขณะนี้อยู่นอกเวลาทำการ โดยแอดมินจะตอบกลับในช่วงเวลาทำการ 08:00–17:00 น. ค่ะ🙏 ให้น้องใจดีช่วยดูแลนะคะ'

// Thai timezone UTC+7: 18:00–07:59 = นอกเวลาทำการ
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

      try {
        // --- SESSION GREETING — แจ้ง/ทักทายครั้งแรกตามช่วงเวลา ---
        let offHoursNotice: string | null = null
        let showGreeting = false
        const thaiHour = (new Date().getUTCHours() + 7) % 24

        if (thaiHour >= 18 || thaiHour < 8) {
          // นอกเวลาทำการ — แจ้ง off-hours notice ครั้งแรก
          try {
            const alreadyNotified = await redis.get(`off_hours:${userId}`)
            if (!alreadyNotified) {
              await redis.set(`off_hours:${userId}`, '1', { ex: OFF_HOURS_TTL })
              offHoursNotice = OFF_HOURS_NOTICE
            }
          } catch { /* Redis ล่ม — ข้าม */ }
        } else {
          // ในเวลาทำการ — ทักทายด้วย greeting card ครั้งแรก
          try {
            const alreadyGreeted = await redis.get(`in_hours:${userId}`)
            if (!alreadyGreeted) {
              await redis.set(`in_hours:${userId}`, '1', { ex: IN_HOURS_TTL })
              showGreeting = true
            }
          } catch { /* Redis ล่ม — ข้าม */ }
        }

        // ข้อความแรกนอกเวลา → ส่งแค่ notice แล้วหยุด (ข้อความถัดไปตอบปกติ)
        if (offHoursNotice) {
          await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: offHoursNotice }],
          })
          log.info('off_hours.notice_only', { userId })
          return
        }

        // Helper — prepend greeting card เป็น bubble แรก (เฉพาะเวลาทำการ)
        const txt = (text: string): messagingApi.Message[] => {
          const msgs: messagingApi.Message[] = []
          if (showGreeting) msgs.push(greetingCard() as messagingApi.Message)
          msgs.push({ type: 'text', text })
          return msgs
        }

        // --- TEXT ---
        if (msgType === 'text') {
          const userMessage = (event.message as { text: string }).text
          const history = await getHistory(userId)
          const handoffMsg = getHandoffMessage()

          // Admin release takeover: "คืนบอท:{targetUserId}"
          if (userMessage.startsWith('คืนบอท:')) {
            const targetId = userMessage.slice('คืนบอท:'.length).trim()
            if (targetId) {
              try { await redis.del(`takeover:${targetId}`) } catch { /* Redis ล่ม */ }
              await lineClient.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: `✅ คืนน้องใจดีดูแลลูกค้าแล้วค่ะ (${targetId.slice(-6)})` }],
              })
              log.info('takeover.released', { by: userId, target: targetId })
              return
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
              // ภายใน 60 วินาที → process image + text ด้วยกัน
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
                return DEFAULT_REPLY
              })
              await lineClient.replyMessage({ replyToken, messages: txt(reply) })
              await saveHistory(userId, [...history, { role: 'user', text: `[รูปภาพ] ${userMessage}` }, { role: 'model', text: reply }])
              log.info('image_text_reply.sent', { userId, latencyMs: Date.now() - startTime })
              return
            } else {
              // เกิน 60 วินาที → OCR รูปก่อน บันทึก context → แสดง 4-ปุ่ม card
              try { await redis.del(`img_data:${userId}`) } catch { /* */ }

              // ดาวน์โหลดรูปและ OCR เพื่อบันทึก context ลง history
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
                const product = ocrRes.text?.trim() || 'ไม่ระบุ'
                await saveHistory(userId, [...history, { role: 'user', text: `[ลูกค้าส่งรูปภาพสินค้า: ${product}]` }, { role: 'model', text: '[แสดงเมนูตัวเลือก]' }])
                log.info('image.ocr_saved', { userId, product })
              } catch { /* OCR ล้มเหลว — ข้ามได้ */ }

              const cardMsgs: messagingApi.Message[] = []
              if (offHoursNotice) cardMsgs.push({ type: 'text', text: offHoursNotice })
              if (showGreeting) cardMsgs.push(greetingCard() as messagingApi.Message)
              cardMsgs.push(imageIntentCard() as messagingApi.Message)
              await lineClient.replyMessage({ replyToken, messages: cardMsgs })
              log.info('image.intent_card_sent_delayed', { userId, elapsedMs: elapsed })
              return
            }
          }

          // ลูกค้ากด "สอบถามสเปก" จาก imageIntentCard → โหลดรูปที่บันทึกไว้แล้ววิเคราะห์
          if (userMessage === 'สอบถามสเปก') {
            let imageId: string | null = null
            try {
              imageId = await redis.get<string>(`img:${userId}`)
              if (imageId) await redis.del(`img:${userId}`)
            } catch {
              // Redis ล่ม — ตกลงไป FAQ flow ปกติ
            }

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
                return DEFAULT_REPLY
              })

              await lineClient.replyMessage({ replyToken, messages: txt(reply) })
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

          // ทักทาย — ตอบครั้งแรกเท่านั้นต่อวัน (เฉพาะในเวลาทำการ)
          if ((thaiHour >= 8 && thaiHour < 18) && GREETING_KEYWORDS.some(kw => userMessage.includes(kw))) {
            let alreadyGreeted = false
            try {
              alreadyGreeted = !!(await redis.get(`greeting:${userId}`))
              if (!alreadyGreeted) await redis.set(`greeting:${userId}`, '1', { ex: GREETING_TTL })
            } catch { /* Redis ล่ม */ }
            if (!alreadyGreeted) {
              await lineClient.replyMessage({ replyToken, messages: txt(GREETING_MSG) })
              await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: GREETING_MSG }])
              log.info('reply.greeting', { userId })
              return
            }
          }

          // ตรวจ pre-handoff state (atomic getdel — ป้องกัน race condition)
          let pendingTrigger: string | null = null
          try {
            pendingTrigger = await redis.getdel<string>(`pre_handoff:${userId}`)
          } catch { /* Redis ล่ม — ข้าม */ }

          if (pendingTrigger !== null) {
            try {
              await Promise.all([
                redis.set(`routed:${userId}`, '1', { ex: 300 }),
                redis.set(`takeover:${userId}`, '1', { ex: TAKEOVER_TTL }),
              ])
              await notifyAdmin(userId, `[เรื่องที่ต้องการ]: ${pendingTrigger}\n[รายละเอียด]: ${userMessage}`)
            } catch (notifyErr) {
              log.error('handoff.notify_failed', { err: (notifyErr as Error).message, userId })
            }
            await lineClient.replyMessage({ replyToken, messages: txt(handoffMsg) })
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
            log.info('handoff.after_pre_handoff', { userId, latencyMs: Date.now() - startTime })
            return
          }

          if (shouldHandoff(userMessage)) {
            // ตรวจ cooldown — ป้องกันถามซ้ำหลัง route แล้ว
            let alreadyRouted = false
            try {
              alreadyRouted = !!(await redis.get(`routed:${userId}`))
            } catch { /* Redis ล่ม */ }

            if (alreadyRouted) {
              const alreadyMsg = 'ได้ส่งเรื่องถึงแอดมินแล้วค่ะ รอแอดมินติดต่อกลับด้วยนะคะ 🙏'
              await lineClient.replyMessage({ replyToken, messages: txt(alreadyMsg) })
              log.info('handoff.already_routed', { userId, latencyMs: Date.now() - startTime })
              return
            }

            // บันทึก state แยกจาก reply — Redis ล้มก็ยังถามได้
            try {
              await redis.set(`pre_handoff:${userId}`, userMessage, { ex: PRE_HANDOFF_TTL })
            } catch {
              log.warn('handoff.pre_handoff_save_failed', { userId })
            }
            const preHandoffQ = 'กรุณาแจ้งรายละเอียดที่ต้องการให้แอดมินช่วยด้วยนะคะ เพื่อให้ดูแลได้ถูกต้องค่ะ'
            await lineClient.replyMessage({ replyToken, messages: txt(preHandoffQ) })
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: preHandoffQ }])
            log.info('handoff.pre_handoff_question', { userId, latencyMs: Date.now() - startTime })
            return
          }

          const faqText = await fetchFAQ()
          const reply = await Promise.race([
            generateReply(userMessage, faqText, history, handoffMsg),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('gemini_timeout')), 12000)
            ),
          ]).catch((err) => {
            log.error('gemini.failed', { err: (err as Error).message })
            return DEFAULT_REPLY
          })

          // HANDOFF / HANDOFF: — Gemini ส่งต่อแอดมิน (IMEI confirm หรือ repair/price)
          if (reply === 'HANDOFF' || reply.toUpperCase().startsWith('HANDOFF')) {
            const summary = reply.replace(/^HANDOFF[:\s]*/i, '').trim() || 'ลูกค้าต้องการติดต่อแอดมิน'
            try {
              await Promise.all([
                redis.set(`routed:${userId}`, '1', { ex: 300 }),
                redis.set(`takeover:${userId}`, '1', { ex: TAKEOVER_TTL }),
              ])
              await notifyAdmin(userId, `[สรุปคำสั่ง]: ${summary}`)
            } catch (notifyErr) {
              log.error('handoff.notify_failed', { err: (notifyErr as Error).message, userId })
            }
            await lineClient.replyMessage({ replyToken, messages: txt(handoffMsg) })
            await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
            log.info('handoff.imei_confirmed', { userId, latencyMs: Date.now() - startTime, summary })
            return
          }

          // out-of-domain — ตอบครั้งแรกเท่านั้น ไม่ซ้ำ 24 ชม.
          if (reply === OUT_OF_DOMAIN || reply.startsWith(OUT_OF_DOMAIN)) {
            let alreadySentOD = false
            try {
              alreadySentOD = !!(await redis.get(`out_of_domain:${userId}`))
              if (!alreadySentOD) await redis.set(`out_of_domain:${userId}`, '1', { ex: OUT_OF_DOMAIN_TTL })
            } catch { /* Redis ล่ม */ }

            if (!alreadySentOD) {
              await lineClient.replyMessage({ replyToken, messages: txt(OUT_OF_DOMAIN_MSG) })
              await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: OUT_OF_DOMAIN_MSG }])
              log.info('reply.out_of_domain', { userId })
            } else {
              log.info('reply.out_of_domain_suppressed', { userId })
            }
            return
          }

          // retry logic — ตอบไม่ได้ครั้งแรก ให้ถามใหม่ / ครั้งสองส่งแอดมิน
          if (reply === NOT_FOUND) {
            try {
              const retryKey = `retry:${userId}`
              const hasRetried = await redis.get(retryKey)
              if (hasRetried) {
                await redis.del(retryKey)
                await lineClient.replyMessage({ replyToken, messages: txt(handoffMsg) })
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: handoffMsg }])
                log.info('retry.admin_routed', { userId })
              } else {
                await redis.set(retryKey, '1', { ex: RETRY_TTL })
                const retryMsg = 'ขออภัยค่ะ ไม่พบข้อมูลในระบบ สามารถติดต่อแอดมินหรือช่างเทคนิคได้ในเวลาทำการ 08:00–17:00 น. ค่ะ หรือลองอธิบายเพิ่มเติมได้เลยนะคะ'
                await lineClient.replyMessage({ replyToken, messages: txt(retryMsg) })
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: retryMsg }])
                log.info('retry.first_attempt', { userId })
                // log คำถามที่ตอบไม่ได้ — สำหรับทีม Marketing เพิ่มใน Sheet
                try {
                  await redis.lpush(`unanswered_log`, JSON.stringify({
                    ts: new Date().toISOString(), userId, question: userMessage,
                  }))
                  await redis.ltrim(`unanswered_log`, 0, 499) // เก็บแค่ 500 รายการล่าสุด
                } catch { /* Redis ล่ม — ข้าม */ }
              }
            } catch {
              await lineClient.replyMessage({ replyToken, messages: txt(handoffMsg) })
            }
            return
          }

          await lineClient.replyMessage({ replyToken, messages: txt(reply) })
          await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reply }])
          log.info('reply.sent', { userId, latencyMs: Date.now() - startTime, replyLength: reply.length })
        }

        // --- IMAGE ---
        if (msgType === 'image') {
          const imageId = (event.message as { id: string }).id

          try {
            // บันทึก imageId + timestamp — รอ text จากลูกค้า 60 วินาที
            await Promise.all([
              redis.set(`img:${userId}`, imageId, { ex: 300 }),
              redis.set(`img_data:${userId}`, JSON.stringify({ id: imageId, ts: Date.now() }), { ex: 360 }),
            ])
            log.info('image.received_waiting', { userId, imageId })
          } catch {
            // Redis ล่ม — fallback ส่ง card ทันที
            const fallbackMsgs: messagingApi.Message[] = []
            if (offHoursNotice) fallbackMsgs.push({ type: 'text', text: offHoursNotice })
            if (showGreeting) fallbackMsgs.push(greetingCard() as messagingApi.Message)
            fallbackMsgs.push(imageIntentCard() as messagingApi.Message)
            await lineClient.replyMessage({ replyToken, messages: fallbackMsgs })
            log.info('image.intent_card_sent_fallback', { userId, imageId })
          }
        }

      } catch (err) {
        log.error('webhook.error', { err: (err as Error).message, userId })
        try {
          await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: DEFAULT_REPLY }],
          })
        } catch {
          // replyToken expired or LINE error — swallow
        }
      }
    })
  )

  return NextResponse.json({ ok: true })
}
