import { NextRequest } from 'next/server'
import { refreshSheetNow } from '@/lib/sheet'

// (เรื่องที่ 83) ให้แอดมินกดรีเฟรชชีตทันทีหลังแก้ไขเสร็จ แทนรอแคช 60 วิหมดอายุเอง —
// auth pattern เดียวกับ /api/admin/webhook-errors (key เทียบกับ ADMIN_SCHEDULE_PASSWORD)
function auth(req: NextRequest): boolean {
  const key = req.nextUrl.searchParams.get('key')
  return !!key && key === process.env.ADMIN_SCHEDULE_PASSWORD
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return new Response('Unauthorized', { status: 401 })

  const result = await refreshSheetNow()
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  })
}
