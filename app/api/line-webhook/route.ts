import { NextRequest, NextResponse } from 'next/server'
import { validateSignature, messagingApi } from '@line/bot-sdk'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply, generateReplyWithImage } from '@/lib/gemini'
import { shouldHandoff, notifyAdmin } from '@/lib/handoff'
import { log } from '@/lib/log'

export const runtime = 'nodejs'
export const maxDuration = 30

const DEFAULT_REPLY =
  'ขออภัยค่ะ น้องใจดีไม่มีข้อมูลในส่วนนี้ กรุณาติดต่อทีมงานได้โดยตรงค่ะ'

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
              messages: [{ type: 'text', text: 'ขอแอดมินติดต่อกลับนะคะ 🙏' }],
            })
            log.info('handoff.routed', { userId, latencyMs: Date.now() - startTime })
            return
          }

          const faqText = await fetchFAQ()
          const reply = await Promise.race([
            generateReply(userMessage, faqText),
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

          const stream = await lineClient.getMessageContent(imageId)
          const chunks: Buffer[] = []
          for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk))
          }
          const imageBuffer = Buffer.concat(chunks)
          const base64Image = imageBuffer.toString('base64')

          const faqText = await fetchFAQ()
          const reply = await Promise.race([
            generateReplyWithImage(base64Image, faqText),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('gemini_timeout')), 15000)
            ),
          ]).catch((err) => {
            log.error('gemini.image_failed', { err: (err as Error).message })
            return DEFAULT_REPLY
          })

          await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: reply }],
          })
          log.info('image_reply.sent', {
            userId,
            latencyMs: Date.now() - startTime,
            replyLength: reply.length,
          })
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
