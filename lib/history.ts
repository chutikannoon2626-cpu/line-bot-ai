import { redis } from './redis'

const MAX_TURNS = 6   // เก็บ 3 รอบสนทนา (user+model ×3)
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

// ttlSeconds override — ใช้ตอนปิดบอทตามตารางเวลา (isScheduledOff) เพื่อยืด TTL ให้ history
// ไม่หมดอายุก่อนบอทจะกลับมาเปิดตอบอีกครั้ง (เรื่องที่ 39, 2026-08-08) — ไม่ระบุ = ใช้ HISTORY_TTL เดิมทุกประการ
export async function saveHistory(userId: string, turns: Turn[], ttlSeconds: number = HISTORY_TTL): Promise<void> {
  try {
    await redis.set(`history:${userId}`, turns.slice(-MAX_TURNS), { ex: ttlSeconds })
  } catch {
    // Redis ล่ม — ข้าม
  }
}
