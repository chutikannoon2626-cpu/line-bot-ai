import { redis } from './redis'

const MAX_TURNS = 6   // เก็บ 3 รอบสนทนา (user+model ×3) — Web Chat ใช้ค่านี้
// เฉพาะ LINE/Facebook เท่านั้น (2026-08-11) — เจอเคสจริง: ลูกค้าพิมพ์หลายข้อความสั้นๆ ติดกันเร็ว
// (เช่น แจ้งอาการ, ให้ S/N, ให้ IMEI, ตอบคำถามยืนยัน) ทำให้ context ที่บอกไว้ตอนต้น (เช่น ชื่อรุ่น)
// หลุดออกจากหน้าต่างความจำเร็วเกินไปด้วยค่า MAX_TURNS เดิม บอทถามข้อมูลที่ลูกค้าให้ไปแล้วซ้ำ
const MAX_TURNS_EXTENDED = 12   // เก็บ 6 รอบสนทนา (user+model ×6)
// (เรื่องที่ 94, 2026-09-04) เคยขยายจาก 600s (10 นาที) เป็น 1800s (30 นาที) — เจอเคสจริงลูกค้าหายไป
// 11-20 นาทีระหว่างคุย history หมดอายุก่อนข้อความถัดมาจะมาถึง บอทเลย "ลืม" บริบทที่เคยรับทราบไปแล้ว
// (เรื่องที่ 96, 2026-09-04) ย้อนกลับเป็น 600s (10 นาที) ตามเดิม — ตรวจ git history ย้อนหลังพบว่าค่านี้
// เคยเป็น 1800s มาก่อนแล้วครั้งหนึ่ง (ตอนสร้างฟีเจอร์นี้ครั้งแรก) แล้วถูกลดเหลือ 600s โดยตั้งใจเมื่อ
// 25 มิ.ย. 2569 (commit 6548331) แต่ไม่มีบันทึกเหตุผลไว้ที่ไหนเลย (ไม่มีใน commit message/INSTRUCTIONS.md)
// — พบเบาะแสว่า commit ใกล้เคียงช่วงนั้นมีการเพิ่ม repair_protocol (บทสนทนาหลายรอบ) และเอา history
// check ออกจาก pre_handoff ในเวลาไล่เลี่ยกัน ชวนให้สงสัยว่า TTL ยาวอาจเคยทำให้ context เก่าค้างรบกวน
// protocol อื่น — ยังไม่มีหลักฐานยืนยันแน่ชัด แต่เพื่อความปลอดภัยจึงย้อนกลับค่าเดิมที่เคยใช้งานมานานก่อน
// (ยอมรับความเสี่ยงที่ปัญหาเดิมของเรื่องที่ 94 อาจกลับมาเกิดอีกได้ในเคสที่ลูกค้าหายไปเกิน 10 นาที)
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
