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
    .exec()
    .catch(() => {})                     // ไม่กระทบถ้า Redis ล่ม
}
