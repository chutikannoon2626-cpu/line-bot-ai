import { NextRequest, NextResponse } from 'next/server'
import { validateSignature, messagingApi } from '@line/bot-sdk'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply, generateReplyWithImage } from '@/lib/gemini'
import { shouldHandoff, notifyAdmin } from '@/lib/handoff'
import { log } from '@/lib/log'

export const runtime = 'nodejs'
export const maxDuration = 30

const DEFAULT_REPLY =
  'ขออภัยค่ะ น้องใจดีขอตรวจสอบก่อนนะคะ รบกวนถามใหม่อีกครั้ง หรือจะให้แอดมินติดต่อกลับก็ได้เลยค่ะ'

// เก็บ image ID รอคำถามจากลูกค้า (TTL 5 นาที)
const pendingImages = new Map<string, { imageId: string; ts: number }>()
const PENDING_IMAGE_TTL_MS = 5 * 60 * 1000

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

          if (shouldHandoff(userMessage)) {
            await notifyAdmin(userId, userMessage)
            await lineClient.replyMessage({
              replyToken,
              messages: [{ type: 'text', text: 'รอแอดมินติดต่อกลับนะคะ 🙏' }],
            })
            log.info('handoff.routed', { userId, latencyMs: Date.now() - startTime })
            return
          }

          const faqText = await fetchFAQ()

          // ถ้ามีรูปที่รอคำถามอยู่ → ใช้รูป + คำถามนี้ค้น spenderclub.com
          const pending = pendingImages.get(userId)
          let replyPromise: Promise<string>

          if (pending && Date.now() - pending.ts < PENDING_IMAGE_TTL_MS) {
            pendingImages.delete(userId)
            const blobClient = new messagingApi.MessagingApiBlobClient({
              channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
            })
            const stream = await blobClient.getMessageContent(pending.imageId)
            const chunks: Buffer[] = []
            for await (const chunk of stream) chunks.push(Buffer.from(chunk))
            const base64Image = Buffer.concat(chunks).toString('base64')
            replyPromise = generateReplyWithImage(base64Image, faqText, userMessage)
            log.info('image.with_question', { userId })
          } else {
            replyPromise = generateReply(userMessage, faqText)
          }

          const reply = await Promise.race([
            replyPromise,
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('gemini_timeout')), 8000)
            ),
          ]).catch((err) => {
            log.error('gemini.failed', { err: (err as Error).message })
            return DEFAULT_REPLY
          })

          await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: reply }],
          })
          log.info('reply.sent', {
            userId,
            latencyMs: Date.now() - startTime,
            replyLength: reply.length,
          })
        }

        // --- IMAGE ---
        if (msgType === 'image') {
          const imageId = (event.message as { id: string }).id
          // เก็บรูปไว้รอคำถาม ไม่ตอบทันที
          pendingImages.set(userId, { imageId, ts: Date.now() })
          await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: 'ได้รับรูปภาพแล้วค่ะ รบกวนพิมพ์คำถามที่ต้องการทราบด้วยนะคะ' }],
          })
          log.info('image.pending', { userId, latencyMs: Date.now() - startTime })
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
