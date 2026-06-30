import { NextRequest } from 'next/server'
import { getRules, saveRules, ScheduleRule } from '@/lib/schedule'

function auth(req: NextRequest): boolean {
  const key = req.nextUrl.searchParams.get('key')
  return !!key && key === process.env.ADMIN_SCHEDULE_PASSWORD
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const rules = await getRules()
  return new Response(JSON.stringify(rules), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const body = await req.json() as Pick<ScheduleRule, 'days' | 'startTime' | 'endTime'>
  const rules = await getRules()
  const newRule: ScheduleRule = {
    id: Date.now().toString(),
    days: body.days,
    startTime: body.startTime,
    endTime: body.endTime,
    enabled: true,
  }
  await saveRules([...rules, newRule])
  return new Response(JSON.stringify(newRule), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function PATCH(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const { id, enabled } = await req.json() as { id: string; enabled: boolean }
  const rules = await getRules()
  await saveRules(rules.map(r => r.id === id ? { ...r, enabled } : r))
  return new Response('ok')
}

export async function DELETE(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const { id } = await req.json() as { id: string }
  const rules = await getRules()
  await saveRules(rules.filter(r => r.id !== id))
  return new Response('ok')
}
