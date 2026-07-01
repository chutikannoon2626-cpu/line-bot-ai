import { NextRequest } from 'next/server'
import { getRules, saveRules, ScheduleRule, Channel } from '@/lib/schedule'

function auth(req: NextRequest): boolean {
  const key = req.nextUrl.searchParams.get('key')
  return !!key && key === process.env.ADMIN_SCHEDULE_PASSWORD
}

function getChannel(req: NextRequest): Channel {
  const ch = req.nextUrl.searchParams.get('channel')
  if (ch === 'fb' || ch === 'web') return ch
  return 'line'
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const rules = await getRules(getChannel(req))
  return new Response(JSON.stringify(rules), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const channel = getChannel(req)
  const body = await req.json() as Pick<ScheduleRule, 'days' | 'startTime' | 'endTime'>
  const rules = await getRules(channel)
  const newRule: ScheduleRule = {
    id: Date.now().toString(),
    days: body.days,
    startTime: body.startTime,
    endTime: body.endTime,
    enabled: true,
  }
  await saveRules(channel, [...rules, newRule])
  return new Response(JSON.stringify(newRule), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function PATCH(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const channel = getChannel(req)
  const { id, enabled } = await req.json() as { id: string; enabled: boolean }
  const rules = await getRules(channel)
  await saveRules(channel, rules.map(r => r.id === id ? { ...r, enabled } : r))
  return new Response('ok')
}

export async function DELETE(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const channel = getChannel(req)
  const { id } = await req.json() as { id: string }
  const rules = await getRules(channel)
  await saveRules(channel, rules.filter(r => r.id !== id))
  return new Response('ok')
}
