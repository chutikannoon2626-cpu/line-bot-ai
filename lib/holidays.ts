import { redis } from './redis'

export interface HolidayRule {
  id: string
  startDate: string  // "YYYY-MM-DD"
  endDate: string    // "YYYY-MM-DD" (รวมวันนี้ด้วย)
  label: string       // ชื่อวันหยุด เช่น "วันหยุดสงกรานต์"
  message: string     // ข้อความแจ้งลูกค้า
  enabled: boolean
}

const KEY = 'holidays:rules'

export async function getHolidays(): Promise<HolidayRule[]> {
  try {
    return (await redis.get<HolidayRule[]>(KEY)) ?? []
  } catch {
    return []
  }
}

export async function saveHolidays(rules: HolidayRule[]): Promise<void> {
  await redis.set(KEY, rules)
}

function bangkokDateStr(): string {
  const bangkokNow = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })
  )
  const y = bangkokNow.getFullYear()
  const m = String(bangkokNow.getMonth() + 1).padStart(2, '0')
  const d = String(bangkokNow.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// คืนข้อความแจ้งเตือนของวันหยุดที่เปิดใช้งานอยู่ ถ้าวันนี้ (Bangkok) อยู่ในช่วงวันที่ตั้งไว้
// คืน null ถ้าไม่มีวันหยุดที่ตรง — ไม่ปิดบอท แค่ใช้แนบข้อความแจ้งเตือนไปกับคำตอบปกติ
export async function getActiveHolidayNotice(): Promise<string | null> {
  try {
    const rules = await getHolidays()
    if (rules.length === 0) return null

    const today = bangkokDateStr()
    const active = rules.find(r => r.enabled && r.startDate <= today && today <= r.endDate)
    return active?.message ?? null
  } catch {
    return null  // fail open — ถ้า Redis ล่ม บอทยังทำงานได้ตามปกติ ไม่แนบแจ้งเตือน
  }
}
