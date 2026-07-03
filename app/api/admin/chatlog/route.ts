import { NextRequest } from 'next/server'
import { redis } from '@/lib/redis'
import type { ChatLogEntry } from '@/lib/chatlog'

export const runtime = 'nodejs'

function auth(req: NextRequest): boolean {
  return req.nextUrl.searchParams.get('key') === process.env.ADMIN_SCHEDULE_PASSWORD
}

// Upstash v1 อาจคืน flat array [member, score, ...] แทน {member,score}[]
function parseZRange(raw: unknown[]): { member: string; score: number }[] {
  if (!raw.length) return []
  if (typeof raw[0] === 'object' && raw[0] !== null && 'member' in raw[0])
    return raw as { member: string; score: number }[]
  const out: { member: string; score: number }[] = []
  for (let i = 0; i + 1 < raw.length; i += 2)
    out.push({ member: String(raw[i]), score: Number(raw[i + 1]) })
  return out
}

export type ConvSummary = {
  userId:      string
  channel:     string
  lastMessage: string
  lastTs:      number
  count:       number
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })

  const userId = req.nextUrl.searchParams.get('userId')

  // ── Single conversation ──
  if (userId) {
    const raw = await redis.lrange(`chatlog:u:${userId}`, 0, 199) as unknown[]
    const messages: ChatLogEntry[] = raw
      .map(s => { try { return (typeof s === 'string' ? JSON.parse(s) : s) as ChatLogEntry } catch { return null } })
      .filter((e): e is ChatLogEntry => e !== null)
      .reverse()  // oldest first
    return new Response(JSON.stringify({ messages }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ── Conversation list (latest 100 users by activity) ──
  const rawConvs = await redis.zrange('chatlog:convs', 0, 99, {
    rev: true, withScores: true,
  }) as unknown[]
  const convList = parseZRange(rawConvs)

  if (!convList.length)
    return new Response(JSON.stringify({ conversations: [] }), {
      headers: { 'Content-Type': 'application/json' },
    })

  const userIds = convList.map(c => c.member)
  const chanMap  = (await redis.hgetall('chatlog:uchan') as Record<string, string> | null) ?? {}

  // Batch: last message + count for each user
  const pipe = redis.pipeline()
  for (const uid of userIds) {
    pipe.lindex(`chatlog:u:${uid}`, 0)  // newest message (JSON string)
    pipe.llen(`chatlog:u:${uid}`)        // total count
  }
  const results = await pipe.exec() as unknown[]

  const conversations: ConvSummary[] = convList.map((c, i) => {
    const lastRaw = results[i * 2] as string | Record<string, unknown> | null
    const count   = Number(results[i * 2 + 1] ?? 0)
    let lastMessage = ''
    if (lastRaw) {
      try {
        const parsed = (typeof lastRaw === 'string' ? JSON.parse(lastRaw) : lastRaw) as ChatLogEntry
        lastMessage = parsed.message.slice(0, 80)
      } catch {}
    }
    return {
      userId:      c.member,
      channel:     chanMap[c.member] ?? 'LINE',
      lastMessage,
      lastTs:      c.score,
      count,
    }
  })

  return new Response(JSON.stringify({ conversations }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
