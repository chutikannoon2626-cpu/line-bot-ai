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
