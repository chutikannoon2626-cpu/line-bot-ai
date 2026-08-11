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

export async function saveHistory(userId: string, turns: Turn[]): Promise<void> {
  try {
    await redis.set(`history:${userId}`, turns.slice(-MAX_TURNS), { ex: HISTORY_TTL })
  } catch {
    // Redis ล่ม — ข้าม
  }
}
