import { NextRequest } from 'next/server'
import { redis } from '@/lib/redis'

function auth(req: NextRequest): boolean {
  const key = req.nextUrl.searchParams.get('key')
  return !!key && key === process.env.ADMIN_SCHEDULE_PASSWORD
}

type ImageFailureEntry = {
  ts: string
  userId: string
  latencyMs: number
  imageCount: number
  channel: 'line' | 'facebook'
  reason: string
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })

  const raw = await redis.lrange('image_text_failure_log', 0, 99)

  const failures: ImageFailureEntry[] = (raw as string[])
    .map(item => {
      try { return typeof item === 'string' ? JSON.parse(item) as ImageFailureEntry : item as ImageFailureEntry }
      catch { return null }
    })
    .filter((x): x is ImageFailureEntry => x !== null)

  return new Response(JSON.stringify({ failures }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function DELETE(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  await redis.del('image_text_failure_log')
  return new Response('ok')
}
