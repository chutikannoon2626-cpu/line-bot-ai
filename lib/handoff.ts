import { messagingApi } from '@line/bot-sdk'

const HANDOFF_TRIGGERS = [
  'คุยกับคน',
  'ขอแอดมิน',
  'ติดต่อแอดมิน',
  'ขอเจ้าของ',
  'ฟ้อง',
  'ร้องเรียน',
  'ไม่พอใจ',
  'ขายส่ง',
  'wholesale',
  'อยากซื้อจำนวน',
  'ขอใบเสนอราคา',
  'quotation',
  'ขอ quote',
  'franchise',
  'ตัวแทนจำหน่าย',
  'dealer',
  'ติดต่อสื่อ',
  'ติดต่อศูนย์บริการ',
  // service requests ที่ต้องการแอดมินดำเนินการ
  'เพิ่มกลุ่ม',
  'ขอเพิ่มกลุ่ม',
  'เพิ่มเครื่อง',
  'ลงทะเบียนกลุ่ม',
  'เพิ่มอุปกรณ์',
  'ขอเพิ่มเครื่อง',
  'HANDOFF',
  'handoff',
]

export function shouldHandoff(message: string): boolean {
  const lower = message.toLowerCase()
  return HANDOFF_TRIGGERS.some((trigger) => lower.includes(trigger.toLowerCase()))
}

// ─── LINE OA / Facebook เท่านั้น — แยก handoff เป็น 2 ระดับตามลำดับ INSTRUCTIONS.md เรื่องที่ 3 ───
// ทันที: ลูกค้าขอคนโดยตรง หรือร้องเรียน — ข้ามชั้นค้นชีต/ค้นเว็บได้เลย
const IMMEDIATE_HANDOFF_TRIGGERS = [
  'คุยกับคน',
  'ขอแอดมิน',
  'ติดต่อแอดมิน',
  'ฟ้อง',
  'ร้องเรียน',
  'ไม่พอใจ',
]

// รอก่อน: ต้องค้นชีต (FAQ/Product) แล้วค้นเว็บก่อนเสมอ ถ้าไม่เจอทั้งคู่ค่อย handoff
const DEFERRED_HANDOFF_TRIGGERS = [
  'ขายส่ง',
  'wholesale',
  'อยากซื้อจำนวน',
  'ขอใบเสนอราคา',
  'quotation',
  'ขอ quote',
  'franchise',
  'ตัวแทนจำหน่าย',
  'dealer',
  'ติดต่อสื่อ',
  'ติดต่อศูนย์บริการ',
  // service requests ที่ต้องการแอดมินดำเนินการ
  'เพิ่มกลุ่ม',
  'ขอเพิ่มกลุ่ม',
  'เพิ่มเครื่อง',
  'ลงทะเบียนกลุ่ม',
  'เพิ่มอุปกรณ์',
  'ขอเพิ่มเครื่อง',
  'HANDOFF',
  'handoff',
]

export function shouldHandoffImmediate(message: string): boolean {
  const lower = message.toLowerCase()
  return IMMEDIATE_HANDOFF_TRIGGERS.some((trigger) => lower.includes(trigger.toLowerCase()))
}

export function shouldHandoffDeferred(message: string): boolean {
  const lower = message.toLowerCase()
  return DEFERRED_HANDOFF_TRIGGERS.some((trigger) => lower.includes(trigger.toLowerCase()))
}

// "ขอเจ้าของ" — ทำงานต่างจากกลุ่มอื่นตามเวลาทำการ (Asia/Bangkok):
// ในเวลาทำการ (08:00–17:59) → immediate handoff เหมือน shouldHandoffImmediate
// นอกเวลาทำการ (18:00–07:59) → ไม่ handoff เลย ตอบข้อความนอกเวลาแทน (ดู OWNER_REQUEST_OFF_HOURS_MSG)
const OWNER_REQUEST_TRIGGERS = ['ขอเจ้าของ']

export function isOwnerRequest(message: string): boolean {
  const lower = message.toLowerCase()
  return OWNER_REQUEST_TRIGGERS.some((trigger) => lower.includes(trigger.toLowerCase()))
}

export const OWNER_REQUEST_OFF_HOURS_MSG =
  'ขณะนี้อยู่นอกเวลาทำการค่ะ\nสอบถามได้ที่ @spenderclub โทร 085-222-9111\nเวลาทำการ 08:00–17:00 น. (จันทร์–เสาร์) ค่ะ'

export async function notifyAdminFacebook(psid: string, userMessage: string): Promise<void> {
  const lineClient = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
  })
  const adminGroupId = process.env.ADMIN_GROUP_ID
  if (!adminGroupId) {
    console.warn('[handoff] ADMIN_GROUP_ID not set · skipping admin notify')
    return
  }

  await lineClient.pushMessage({
    to: adminGroupId,
    messages: [
      {
        type: 'text',
        text: `🔔 [Facebook] ลูกค้าต้องการคุยกับแอดมิน\n\nFacebook ID: ${psid}\nข้อความ: ${userMessage}\n\nไปตอบที่: https://business.facebook.com/inbox`,
      },
    ],
  })
}

export async function notifyAdmin(userId: string, userMessage: string): Promise<void> {
  const lineClient = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
  })
  const adminGroupId = process.env.ADMIN_GROUP_ID
  if (!adminGroupId) {
    console.warn('[handoff] ADMIN_GROUP_ID not set · skipping admin notify')
    return
  }

  await lineClient.pushMessage({
    to: adminGroupId,
    messages: [
      {
        type: 'text',
        text: `🔔 ลูกค้าต้องการคุยกับแอดมิน\n\nUserID: ${userId}\nข้อความ: ${userMessage}\n\nไปคุยที่: https://manager.line.biz/chats\n\n✅ เมื่อดูแลเสร็จ ส่ง:\nคืนบอท:${userId}`,
      },
    ],
  })
}
