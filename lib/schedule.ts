import { redis } from './redis'

export interface ScheduleRule {
  id: string
  days: number[]     // 0=อาทิตย์ 1=จันทร์ ... 6=เสาร์
  startTime: string  // "HH:MM" 24h
  endTime: string    // "HH:MM" 24h
  enabled: boolean
}

const KEY = 'schedule:rules'

export async function getRules(): Promise<ScheduleRule[]> {
  try {
    return (await redis.get<ScheduleRule[]>(KEY)) ?? []
  } catch {
    return []
  }
}

export async function saveRules(rules: ScheduleRule[]): Promise<void> {
  await redis.set(KEY, rules)
}

// คืนค่า true ถ้าเวลาปัจจุบัน (Thai timezone) ตรงกับกฎที่เปิดใช้งานอยู่
export async function isScheduledOff(): Promise<boolean> {
  try {
    const rules = await getRules()
    if (rules.length === 0) return false

    const bangkokNow = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })
    )
    const dow = bangkokNow.getDay()
    const cur = bangkokNow.getHours() * 60 + bangkokNow.getMinutes()

    return rules.some(r => {
      if (!r.enabled) return false
      if (!r.days.includes(dow)) return false
      const [sh, sm] = r.startTime.split(':').map(Number)
      const [eh, em] = r.endTime.split(':').map(Number)
      const start = sh * 60 + sm
      const end   = eh * 60 + em
      // รองรับช่วงข้ามคืน เช่น 18:00–07:59
      return start < end ? cur >= start && cur < end : cur >= start || cur < end
    })
  } catch {
    return false  // fail open — ถ้า Redis ล่ม บอทยังทำงานได้ตามปกติ
  }
}
