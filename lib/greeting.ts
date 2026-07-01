import { redis } from '@/lib/redis'

export const WELCOME_MSG =
  'Spender Club ยินดีต้อนรับค่ะ 😊\n' +
  '(ขณะนี้อยู่ระหว่างการทดสอบระบบตอบกลับอัตโนมัติค่ะ)\n' +
  'ขอบคุณที่สนใจวิทยุสื่อสาร Spender Club\n' +
  'สอบถามข้อมูลด้านใดพิมพ์ได้เลยนะคะ'

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
