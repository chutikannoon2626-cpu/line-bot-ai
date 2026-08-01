import { NextRequest } from 'next/server'
import { getHolidays, saveHolidays, HolidayRule } from '@/lib/holidays'

function auth(req: NextRequest): boolean {
  const key = req.nextUrl.searchParams.get('key')
  return !!key && key === process.env.ADMIN_SCHEDULE_PASSWORD
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const rules = await getHolidays()
  return new Response(JSON.stringify(rules), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const body = await req.json() as Pick<HolidayRule, 'startDate' | 'endDate' | 'label' | 'message'>
  const rules = await getHolidays()
  const newRule: HolidayRule = {
    id: Date.now().toString(),
    startDate: body.startDate,
    endDate: body.endDate,
    label: body.label,
    message: body.message,
    enabled: true,
  }
  await saveHolidays([...rules, newRule])
  return new Response(JSON.stringify(newRule), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function PATCH(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const { id, enabled } = await req.json() as { id: string; enabled: boolean }
  const rules = await getHolidays()
  await saveHolidays(rules.map(r => r.id === id ? { ...r, enabled } : r))
  return new Response('ok')
}

export async function DELETE(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })
  const { id } = await req.json() as { id: string }
  const rules = await getHolidays()
  await saveHolidays(rules.filter(r => r.id !== id))
  return new Response('ok')
}
