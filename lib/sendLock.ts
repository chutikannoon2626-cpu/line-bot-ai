import { redis } from './redis'
import { log } from './log'

// กันข้อความหลายข้อความจากลูกค้าคนเดียวกันยิง LINE/Facebook Send API พร้อมกัน
// (concurrent) จนแย่งกัน ทำให้ replyToken หมดอายุ + โดน rate limit (429) พร้อมกันทั้งคู่
// — ใช้ Redis เป็น distributed lock ต่อ "1 คำระบุตัวลูกค้า" (userId ของ LINE หรือ
// "fb:{psid}" ของ Facebook — คนละ namespace กันชนกันโดยบังเอิญ) ให้ข้อความที่ 2
// รอข้อความแรกส่งเสร็จ (สำเร็จหรือ retry ครบแล้วก็ตาม) ก่อนค่อยเริ่มยิง API เอง (2026-08-05)

const LOCK_PREFIX = 'lock:send:'
const LOCK_TTL_MS = 15000
const POLL_INTERVAL_MS = 300
const MAX_WAIT_MS = 12000 // เกินนี้ bypass ไปทำงานเลย กัน deadlock ถ้า lock ค้าง

export async function withUserSendLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${LOCK_PREFIX}${userId}`
  const start = Date.now()
  let acquired = false

  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const ok = await redis.set(key, '1', { nx: true, px: LOCK_TTL_MS })
      if (ok) {
        acquired = true
        break
      }
    } catch {
      // Redis ล่ม — bypass ทันที ไม่บล็อกลูกค้าเพราะ lock ใช้งานไม่ได้
      break
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  if (acquired) {
    log.info('sendlock.acquired', { userId, waitedMs: Date.now() - start })
  } else {
    log.warn('sendlock.bypassed', { userId, waitedMs: Date.now() - start })
  }

  try {
    return await fn()
  } finally {
    if (acquired) {
      try {
        await redis.del(key)
        log.info('sendlock.released', { userId })
      } catch { /* Redis ล่ม — ปล่อยตาม TTL เองภายใน 15s */ }
    }
  }
}
