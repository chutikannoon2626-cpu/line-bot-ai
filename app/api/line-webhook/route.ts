import { NextRequest, NextResponse } from 'next/server'
import { validateSignature, messagingApi } from '@line/bot-sdk'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply, generateReplyWithImage } from '@/lib/gemini'
import { shouldHandoff, notifyAdmin } from '@/lib/handoff'
import { log } from '@/lib/log'
import { redis } from '@/lib/redis'
import { imageIntentCard } from '@/lib/flex-cards'
import { getHistory, saveHistory } from '@/lib/history'

const NOT_FOUND = '[NOT_FOUND]'
const RETRY_TTL = 600       // 10 นาที
const PRE_HANDOFF_TTL = 600 // 10 นาที

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
        // --- TEXT ---
        if (msgType === 'text') {
          const userMessage = (event.message as { text: string }).text
          const history = await getHistory(userId)
          const handoffMsg = getHandoffMessage()

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

              await lineClient.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: reply }],
              })
              log.info('image_spec_reply.sent', { userId, latencyMs: Date.now() - startTime })
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
              await redis.set(`routed:${userId}`, '1', { ex: 300 })
              await notifyAdmin(userId, `[เรื่องที่ต้องการ]: ${pendingTrigger}\n[รายละเอียด]: ${userMessage}`)
            } catch (notifyErr) {
              log.error('handoff.notify_failed', { err: (notifyErr as Error).message, userId })
            }
            await lineClient.replyMessage({
              replyToken,
              messages: [{ type: 'text', text: handoffMsg }],
            })
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
              await lineClient.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: alreadyMsg }],
              })
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
            await lineClient.replyMessage({
              replyToken,
              messages: [{ type: 'text', text: preHandoffQ }],
            })
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

          // retry logic — ตอบไม่ได้ครั้งแรก ให้ถามใหม่ / ครั้งสองส่งแอดมิน
          if (reply === NOT_FOUND) {
            try {
              const retryKey = `retry:${userId}`
              const hasRetried = await redis.get(retryKey)
              if (hasRetried) {
                await redis.del(retryKey)
                const adminMsg = handoffMsg
                await lineClient.replyMessage({
                  replyToken,
                  messages: [{ type: 'text', text: adminMsg }],
                })
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: adminMsg }])
                log.info('retry.admin_routed', { userId })
              } else {
                await redis.set(retryKey, '1', { ex: RETRY_TTL })
                const retryMsg = 'ขออภัยค่ะ ไม่พบข้อมูลในระบบ สามารถติดต่อแอดมินหรือช่างเทคนิคได้ในเวลาทำการ 08:00–17:00 น. ค่ะ หรือลองอธิบายเพิ่มเติมได้เลยนะคะ'
                await lineClient.replyMessage({
                  replyToken,
                  messages: [{ type: 'text', text: retryMsg }],
                })
                await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: retryMsg }])
                log.info('retry.first_attempt', { userId })
              }
            } catch {
              // Redis ล่ม → fallback ส่งแอดมินทันที
              await lineClient.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: handoffMsg }],
              })
            }
            return
          }

          await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: reply }],
          })
          await saveHistory(userId, [...history, { role: 'user', text: userMessage }, { role: 'model', text: reply }])
          log.info('reply.sent', {
            userId,
            latencyMs: Date.now() - startTime,
            replyLength: reply.length,
          })
        }

        // --- IMAGE ---
        if (msgType === 'image') {
          const imageId = (event.message as { id: string }).id

          try {
            await redis.set(`img:${userId}`, imageId, { ex: 300 })
          } catch {
            // Redis ล่ม — ยังส่ง card ได้ แต่ปุ่ม "สอบถามสเปก" จะไม่พบรูป
          }

          await lineClient.replyMessage({
            replyToken,
            messages: [imageIntentCard()],
          })
          log.info('image.intent_card_sent', { userId, imageId })
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
