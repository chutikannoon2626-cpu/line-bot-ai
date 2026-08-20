import { NextRequest } from 'next/server'
import { redis } from '@/lib/redis'

function auth(req: NextRequest): boolean {
  const key = req.nextUrl.searchParams.get('key')
  return !!key && key === process.env.ADMIN_SCHEDULE_PASSWORD
}

type WebhookErrorEntry = {
  ts: string
  userId: string
  channel: 'line' | 'facebook'
  type: string
  detail: string
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })

  const raw = await redis.lrange('webhook_error_log', 0, 99)

  const errors: WebhookErrorEntry[] = (raw as string[])
    .map(item => {
      try { return typeof item === 'string' ? JSON.parse(item) as WebhookErrorEntry : item as WebhookErrorEntry }
      catch { return null }
    })
    .filter((x): x is WebhookErrorEntry => x !== null)

  return new Response(JSON.stringify({ errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function DELETE(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  await redis.del('webhook_error_log')
  return new Response('ok')
}
