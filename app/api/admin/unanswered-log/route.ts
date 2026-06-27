import { NextRequest, NextResponse } from 'next/server'
import { redis } from '@/lib/redis'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  // ป้องกันด้วย secret key — ต้องส่ง ?key=LINE_CHANNEL_SECRET
  const key = new URL(req.url).searchParams.get('key')
  if (!key || key !== process.env.LINE_CHANNEL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const raw = await redis.lrange('unanswered_log', 0, -1)
    const items = raw.map((item) => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item
      } catch {
        return item
      }
    })

    return NextResponse.json({
      total: items.length,
      items: items.reverse(), // ล่าสุดขึ้นก่อน
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
