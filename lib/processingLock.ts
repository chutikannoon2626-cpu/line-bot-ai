import { redis } from './redis'
import { log } from './log'

// (เรื่องที่ 98) กันข้อความ 2 ข้อความจากลูกค้าคนเดียวกันที่พิมพ์ติดกันเร็วมาก (เช่น "ตรง Name"
// แล้ว "ใช่ครับ" ห่างกันแค่ 1-2 วิ) ถูกประมวลผลพร้อมกันจนข้อความที่ 2 อ่าน history ก่อนข้อความแรก
// จะบันทึกคำตอบเสร็จ ทำให้ข้อความที่ 2 มองไม่เห็นคำตอบ/context ของข้อความแรกเลย — เจอเคสจริง 2 แบบ:
// (1) บอทตอบผิดเรื่อง (ถามฝาครอบเสาแล้วบอกว่าฝาหาย บอทกลับตอบเรื่องเครื่องหาย เพราะ history ยังไม่มี
// context ฝาครอบเสา) (2) บอทตอบซ้ำเรื่องเดิม 2 รอบคำพูดคนละแบบ (ลูกค้ายืนยัน 2 ครั้งติดกันด้วยคำพูด
// ต่างกัน "ตรง Name"/"ใช่ครับ" แต่ละครั้งไม่เห็นว่าอีกฝั่งเพิ่งตอบไปแล้ว) — คนละ key namespace กับ
// lock:send: (sendLock.ts ป้องกันแค่ขั้นตอนยิง LINE/Facebook Send API เท่านั้น ไม่ครอบคลุมขั้นตอน
// อ่าน/เขียน history) ให้ข้อความที่ 2 รอข้อความแรกประมวลผล+บันทึก history เสร็จก่อน ค่อยเริ่มอ่าน
// history ใหม่ (สดล่าสุด) ก่อนประมวลผลของตัวเอง

const LOCK_PREFIX = 'lock:process:'
const LOCK_TTL_MS = 40000 // สูงสุดที่ 1 ข้อความควรใช้เวลาประมวลผล (fetchFAQ + Gemini 30s + ส่งข้อความ) กัน lock ค้างถาวรถ้า process ตายกลางทาง
const POLL_INTERVAL_MS = 300
const MAX_WAIT_MS = 20000 // เกินนี้ bypass ไปทำงานเลยด้วย history เท่าที่มี กัน deadlock/รอนานเกินไปจนชน webhook timeout

export async function withUserProcessingLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
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
    log.info('processlock.acquired', { userId, waitedMs: Date.now() - start })
  } else {
    log.warn('processlock.bypassed', { userId, waitedMs: Date.now() - start })
  }

  try {
    return await fn()
  } finally {
    if (acquired) {
      try {
        await redis.del(key)
        log.info('processlock.released', { userId })
      } catch { /* Redis ล่ม — ปล่อยตาม TTL เองภายใน 40s */ }
    }
  }
}
