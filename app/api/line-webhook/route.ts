import { NextRequest, NextResponse } from 'next/server'
import { validateSignature, messagingApi } from '@line/bot-sdk'
import { getFAQ } from '@/lib/sheet'
import { getReply } from '@/lib/gemini'

const DEFAULT_REPLY =
  'ขออภัยค่ะ น้องใจดีไม่มีข้อมูลในส่วนนี้ กรุณาติดต่อทีมงานได้โดยตรงค่ะ'

interface TextMessageEvent {
  type: 'message'
  replyToken: string
  message: { type: 'text'; text: string }
  [key: string]: unknown
}

interface WebhookBody {
  events: Array<{ type: string; [key: string]: unknown }>
}

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
})

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-line-signature') ?? ''
  const rawBody = await req.text()

  if (!validateSignature(rawBody, process.env.LINE_CHANNEL_SECRET!, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const body = JSON.parse(rawBody) as WebhookBody
  const textEvents = body.events.filter(
    (e): e is TextMessageEvent =>
      e.type === 'message' &&
      typeof e.message === 'object' &&
      e.message !== null &&
      (e.message as { type: string }).type === 'text',
  )

  await Promise.all(
    textEvents.map(async (event) => {
      const userMessage = event.message.text
      const replyToken = event.replyToken

      let replyText = DEFAULT_REPLY
      try {
        const csvContent = await getFAQ()
        replyText = await getReply(userMessage, csvContent)
      } catch (err) {
        console.error('[webhook] processing error:', err)
      }

      try {
        await client.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: replyText }],
        })
      } catch (err) {
        console.error('[webhook] reply error:', err)
      }
    }),
  )

  return NextResponse.json({ ok: true })
}
