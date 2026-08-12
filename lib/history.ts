import { redis } from './redis'

const MAX_TURNS = 6   // เก็บ 3 รอบสนทนา (user+model ×3) — Web Chat ใช้ค่านี้
// เฉพาะ LINE/Facebook เท่านั้น (2026-08-11) — เจอเคสจริง: ลูกค้าพิมพ์หลายข้อความสั้นๆ ติดกันเร็ว
// (เช่น แจ้งอาการ, ให้ S/N, ให้ IMEI, ตอบคำถามยืนยัน) ทำให้ context ที่บอกไว้ตอนต้น (เช่น ชื่อรุ่น)
// หลุดออกจากหน้าต่างความจำเร็วเกินไปด้วยค่า MAX_TURNS เดิม บอทถามข้อมูลที่ลูกค้าให้ไปแล้วซ้ำ
const MAX_TURNS_EXTENDED = 12   // เก็บ 6 รอบสนทนา (user+model ×6)
const HISTORY_TTL = 600   // 10 นาที

export type Turn = { role: 'user' | 'model'; text: string }

export async function getHistory(userId: string): Promise<Turn[]> {
  try {
    const raw = await redis.get<Turn[]>(`history:${userId}`)
    return raw ?? []
  } catch {
    return []
  }
}

export async function saveHistory(userId: string, turns: Turn[]): Promise<void> {
  try {
    await redis.set(`history:${userId}`, turns.slice(-MAX_TURNS), { ex: HISTORY_TTL })
  } catch {
    // Redis ล่ม — ข้าม
  }
}

// เฉพาะ LINE/Facebook เท่านั้น — ไม่แตะ Web Chat (ยังใช้ saveHistory()/MAX_TURNS เดิมทุกประการ)
export async function saveHistoryExtended(userId: string, turns: Turn[]): Promise<void> {
  try {
    await redis.set(`history:${userId}`, turns.slice(-MAX_TURNS_EXTENDED), { ex: HISTORY_TTL })
  } catch {
    // Redis ล่ม — ข้าม
  }
}
