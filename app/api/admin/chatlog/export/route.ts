import { NextRequest } from 'next/server'
import { redis } from '@/lib/redis'
import * as XLSX from 'xlsx'
import type { ChatLogEntry } from '@/lib/chatlog'

export const runtime = 'nodejs'

function auth(req: NextRequest): boolean {
  return req.nextUrl.searchParams.get('key') === process.env.ADMIN_SCHEDULE_PASSWORD
}

function bkkDateStr(ts: number): string {
  return new Date(ts).toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  })
}
function bkkTimeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })

  const key    = req.nextUrl.searchParams.get('key')!
  const userId = req.nextUrl.searchParams.get('userId')
  const date   = req.nextUrl.searchParams.get('date')  // YYYY-MM-DD (Bangkok)

  let rows: ChatLogEntry[] = []
  let filename = ''

  if (userId) {
    // ── Single conversation ──
    const raw = await redis.lrange(`chatlog:u:${userId}`, 0, 199) as unknown[]
    rows = raw
      .map(s => { try { return (typeof s === 'string' ? JSON.parse(s) : s) as ChatLogEntry } catch { return null } })
      .filter((e): e is ChatLogEntry => e !== null)
      .reverse()
    filename = `chat_${userId.slice(-8)}_${new Date().toISOString().slice(0, 10)}.xlsx`
  } else {
    // ── All conversations for date (default = today Bangkok) ──
    const dateStr = date ?? new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)
    const from = new Date(dateStr + 'T00:00:00+07:00').getTime()
    const to   = new Date(dateStr + 'T23:59:59+07:00').getTime()

    // Get all users active in this time range
    const rawUsers = await redis.zrange('chatlog:convs', from, to, {
      byScore: true,
    }) as unknown[]

    // Flat-array safe parse (no withScores here, just members)
    const userArr: string[] = Array.isArray(rawUsers)
      ? rawUsers.filter(x => typeof x === 'string').map(String)
      : []

    // Fetch messages for each user in parallel (batched)
    const pipe = redis.pipeline()
    for (const uid of userArr) pipe.lrange(`chatlog:u:${uid}`, 0, 199)
    const allLists = await pipe.exec() as (unknown[] | null)[]

    for (const list of allLists) {
      if (!list) continue
      const entries = list
        .map(s => { try { return (typeof s === 'string' ? JSON.parse(s) : s) as ChatLogEntry } catch { return null } })
        .filter((e): e is ChatLogEntry => e !== null && e.ts >= from && e.ts <= to)
      rows.push(...entries)
    }
    rows.sort((a, b) => a.ts - b.ts)
    filename = `chat_all_${dateStr}.xlsx`
  }

  // ── Build XLSX ──
  const wsData: (string | number)[][] = [
    ['วันที่', 'เวลา', 'ช่องทาง', 'UserId', 'บทบาท', 'ข้อความ'],
    ...rows.map(r => [
      bkkDateStr(r.ts),
      bkkTimeStr(r.ts),
      r.channel,
      r.userId,
      r.role === 'user' ? 'ลูกค้า' : 'น้องใจดี',
      r.message,
    ]),
  ]

  const ws = XLSX.utils.aoa_to_sheet(wsData)
  // Column widths
  ws['!cols'] = [
    { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 28 }, { wch: 10 }, { wch: 80 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'ประวัติแชท')
  const body = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as number[])

  return new Response(body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  })
}
