import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

// Keep-warm ping — กัน cold start ของ line-webhook/fb-webhook/web-chat function ที่ทำให้
// Gemini call แรกหลังไม่มี traffic นาน timeout (GEMINI_UNAVAILABLE) ยิงจาก external cron
// service ทุก 5 นาที (ไม่ใช้ Vercel Cron เพราะ Hobby plan จำกัดแค่ 1 ครั้ง/วัน ไม่พอ)
// ไม่เรียก Gemini/Redis/Sheet ใดๆ เลย ตอบ 200 ทันทีเพื่อให้ endpoint นี้เองก็เบาที่สุดเท่าที่
// ทำได้ ป้องกันด้วย CRON_SECRET กันถูกเรียกจากภายนอกที่ไม่รู้ secret (เรื่องที่ 41, 2026-08-08)
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  return new Response('OK', { status: 200 })
}
