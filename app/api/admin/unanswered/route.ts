import { NextRequest } from 'next/server'
import { redis } from '@/lib/redis'

function auth(req: NextRequest): boolean {
  const key = req.nextUrl.searchParams.get('key')
  return !!key && key === process.env.ADMIN_SCHEDULE_PASSWORD
}

type UnansweredEntry = { ts: string; userId: string; question: string }

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })

  const [raw, rawFreq] = await Promise.all([
    redis.lrange('unanswered_log', 0, 99),
    redis.zrange('question_freq', 0, 29, { rev: true, withScores: true }),
  ])

  const unanswered: UnansweredEntry[] = (raw as string[])
    .map(item => {
      try { return typeof item === 'string' ? JSON.parse(item) as UnansweredEntry : item as UnansweredEntry }
      catch { return null }
    })
    .filter((x): x is UnansweredEntry => x !== null)

  // Upstash v1 คืน flat array [member1, score1, member2, score2, ...]
  // หรือ structured { member, score }[] ขึ้นอยู่กับ version
  type FreqEntry = { member: string; score: number }
  const arr = (rawFreq ?? []) as unknown[]
  let frequent: FreqEntry[]
  if (arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null && 'member' in arr[0]) {
    frequent = arr as FreqEntry[]
  } else {
    frequent = []
    for (let i = 0; i + 1 < arr.length; i += 2) {
      frequent.push({ member: String(arr[i]), score: Number(arr[i + 1]) })
    }
  }

  return new Response(JSON.stringify({ unanswered, frequent }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function DELETE(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const { target } = await req.json() as { target: 'unanswered' | 'freq' }
  if (target === 'unanswered') await redis.del('unanswered_log')
  if (target === 'freq') await redis.del('question_freq')
  return new Response('ok')
}
