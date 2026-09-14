import { redis } from '@/lib/redis'

export type ChatChannel = 'LINE' | 'Facebook' | 'Web'

export interface ChatLogEntry {
  userId:  string
  channel: ChatChannel
  role:    'user' | 'bot'
  message: string
  ts:      number
}

const CONV_INDEX = 'chatlog:convs'  // SortedSet: score=ts, member=userId
const CHAN_MAP   = 'chatlog:uchan'  // Hash: userId → channel
const TTL_SECS   = 30 * 24 * 3600  // 30 วัน

// Fire-and-forget — ไม่ await, ไม่กระทบ webhook response time
export function logChat(entry: ChatLogEntry): void {
  const ts = entry.ts || Date.now()
  const userKey = `chatlog:u:${entry.userId}`
  redis.pipeline()
    .lpush(userKey, JSON.stringify({ ...entry, ts }))
    .ltrim(userKey, 0, 199)              // เก็บ 200 ข้อความต่อ user
    .expire(userKey, TTL_SECS)
    .zadd(CONV_INDEX, { score: ts, member: entry.userId })
    .hset(CHAN_MAP, { [entry.userId]: entry.channel })
    // เจอเคสจริง: CONV_INDEX (chatlog:convs) ไม่เคยมี TTL เลยตั้งแต่สร้างฟีเจอร์นี้มา ต่างจาก
    // userKey แต่ละคนที่หมดอายุ 30 วันตามปกติ — ทำให้รายชื่อ userId สะสมค้างอยู่ตลอดไปแม้ข้อความ
    // จริงจะหมดอายุไปแล้ว พอหน้าแอดมิน "ดาวน์โหลดทั้งหมด" (chatlog/export?all=1) ต้องไล่ดึงทุก userId
    // ที่เคยมีมาทั้งหมด ยิ่งสะสมนานยิ่งช้าจนเกิน timeout ของ Vercel — ลบ member ที่เก่าเกิน 30 วัน
    // (ตรงกับ TTL_SECS เดิม) ออกจาก CONV_INDEX ทุกครั้งที่มีข้อความใหม่เข้ามา ให้ index นี้ไม่มีวัน
    // บวมสะสมไม่มีที่สิ้นสุดอีกต่อไป (2026-09-14)
    .zremrangebyscore(CONV_INDEX, 0, ts - TTL_SECS * 1000)
    .exec()
    .catch(() => {})                     // ไม่กระทบถ้า Redis ล่ม
}
