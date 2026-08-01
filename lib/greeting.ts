import { redis } from '@/lib/redis'

// ท่อนนอกเวลาทำการ แสดงเฉพาะตอน 18:00–07:59 น. เท่านั้น ต่อกับท่อนทักทายหลักที่แสดงทุกครั้ง (2026-08-01)
export function getWelcomeMessage(): string {
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  const offHoursPrefix =
    thaiHour >= 18 || thaiHour < 8
      ? '🙏 ขณะนี้อยู่นอกเวลาทำการ\n\nแอดมินจะตอบกลับในวันและเวลาทำการ 08:00–17:00 น. ค่ะ\n\n'
      : ''
  return (
    offHoursPrefix +
    '🤖 Spender CLUB ยินดีต้อนรับ\n' +
    '(ขณะนี้เป็นระบบตอบกลับอัตโนมัติ)\n\n' +
    'ขอบคุณที่สนใจวิทยุสื่อสาร SPENDER\n\n' +
    'สามารถพิมพ์คำถามได้เลย เช่น\n' +
    '• 💰 สอบถามราคาสินค้า\n' +
    '• 🌐 Spender Network\n' +
    '• 🛠️ การใช้งาน\n\n' +
    'น้องใจดีจะช่วยตอบเบื้องต้น และแอดมินจะดูแลต่อในเวลาทำการค่ะ 😊'
  )
}

// คืน true ถ้าควรส่ง greeting (ครั้งแรก หรือห่างเกิน 24 ชม.)
// atomic: set nx → ถ้า set สำเร็จ = ควรทักทาย, ถ้า key มีอยู่แล้ว = ไม่ทักทาย
export async function shouldGreet(userId: string): Promise<boolean> {
  try {
    const result = await redis.set(`greeted:${userId}`, '1', {
      ex: 24 * 3600,
      nx: true,
    })
    return result !== null
  } catch {
    return false
  }
}
