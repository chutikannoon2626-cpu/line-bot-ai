import { messagingApi, validateSignature, WebhookEvent } from '@line/bot-sdk'
import { fetchFAQ } from '@/lib/sheet'
import { generateReply } from '@/lib/gemini'
import { shouldHandoff, notifyAdmin } from '@/lib/handoff'
import { log } from '@/lib/log'

export const runtime = 'nodejs'
export const maxDuration = 30

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
})

const DEFAULT_REPLY =
  'ขออภัยค่ะ น้องใจดีไม่มีข้อมูลในส่วนนี้ กรุณาติดต่อทีมงานได้โดยตรงค่ะ'

interface WebhookBody {
  events: WebhookEvent[]
}

export async function POST(req: Request) {
  const signature = req.headers.get('x-line-signature') ?? ''
  const rawBody = await req.text()

  if (!validateSignature(rawBody, process.env.LINE_CHANNEL_SECRET!, signature)) {
    log.warn('webhook.invalid_signature')
    return new Response('invalid signature', { status: 401 })
  }

  const { events } = JSON.parse(rawBody) as WebhookBody

  await Promise.all(
    events.map(async (event) => {
      if (event.type !== 'message' || event.message.type !== 'text') return

      const userMessage = event.message.text
      const replyToken = event.replyToken
      const userId =
        event.source.type === 'user'
          ? (event.source.userId ?? 'unknown')
          : event.source.type === 'group'
            ? (event.source.userId ?? 'group_unknown')
            : 'unknown'
      const startTime = Date.now()

      try {
        // 1. Smart Handoff — check before calling Gemini
        if (shouldHandoff(userMessage)) {
          await notifyAdmin(userId, userMessage)
          await replyWithRetry(lineClient, replyToken, 'ขอแอดมินติดต่อกลับนะคะ 🙏', 3)
          log.info('handoff.routed', { userId, latencyMs: Date.now() - startTime })
          return
        }

        // 2. Fetch FAQ (cached 60s · stale-on-fail)
        const faqText = await fetchFAQ()

        // 3. Call Gemini with 8s timeout
        const reply = await Promise.race([
          generateReply(userMessage, faqText),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('gemini_timeout')), 8000)
          ),
        ]).catch((err) => {
          log.error('gemini.failed', { err: (err as Error).message })
          return DEFAULT_REPLY
        })

        // 4. Reply to LINE (with retry)
        await replyWithRetry(lineClient, replyToken, reply, 3)

        log.info('reply.sent', {
          userId,
          latencyMs: Date.now() - startTime,
          replyLength: reply.length,
        })
      } catch (err) {
        log.error('webhook.error', { err: (err as Error).message, userId })
        try {
          await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: DEFAULT_REPLY }],
          })
        } catch {
          // replyToken expired — swallow
        }
      }
    })
  )

  return new Response('ok', { status: 200 })
}

async function replyWithRetry(
  client: messagingApi.MessagingApiClient,
  replyToken: string,
  text: string,
  attempts: number
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text }],
      })
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
}
