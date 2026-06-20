import { GoogleGenAI } from '@google/genai'
import { buildSystemPrompt } from './prompts'
import { searchSpenderClub } from './websearch'

const MODEL = 'gemini-2.5-flash'

// marker พิเศษ — route.ts จะจัดการ retry logic เอง
const DEFAULT_REPLY = '[NOT_FOUND]'

// ใช้เมื่อ API error / timeout เท่านั้น
const API_ERROR_REPLY =
  'ขออภัยค่ะ น้องใจดีไม่พบข้อมูล ต้องการติดต่อแอดมินแจ้งได้เลยนะคะ'

export async function generateReply(
  userMessage: string,
  faqText: string
): Promise<string> {
  const startTime = Date.now()
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })

  // ค้น spenderclub.com ควบคู่กับ FAQ
  const webText = await searchSpenderClub(userMessage).catch(() => '')
  const webContext = webText
    ? `\n\nข้อมูลเพิ่มเติมจาก spenderclub.com (ใช้ได้ถ้าไม่มีใน FAQ):\n${webText}`
    : ''

  const systemPrompt = buildSystemPrompt(
    'น้องใจดี',
    'Spender Club',
    faqText,
    DEFAULT_REPLY,
    'สุภาพ formal ลงท้ายด้วย "ค่ะ" เสมอ'
  )

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: userMessage,
    config: {
      systemInstruction: `${systemPrompt}${webContext}`,
      temperature: 1.0,
      maxOutputTokens: 1024,
    },
  })

  const usage = response.usageMetadata
  const finishReason = response.candidates?.[0]?.finishReason

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'gemini.reply',
      latencyMs: Date.now() - startTime,
      finishReason: finishReason ?? 'unknown',
      textLength: response.text?.length ?? 0,
      thoughtsTokenCount: usage?.thoughtsTokenCount ?? 0,
      candidatesTokenCount: usage?.candidatesTokenCount ?? 0,
      totalTokenCount: usage?.totalTokenCount ?? 0,
    })
  )

  if (finishReason === 'MAX_TOKENS') return API_ERROR_REPLY

  const reply = response.text?.trim()
  return reply || API_ERROR_REPLY
}

export async function generateReplyWithImage(
  base64Image: string,
  faqText: string,
  userQuestion?: string
): Promise<string> {
  const startTime = Date.now()
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })

  // ขั้น 1: อ่านรูป — ดึงชื่อรุ่น/รหัส/แบรนด์ออกมา
  const extractRes = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'ดูรูปนี้แล้วระบุข้อมูลสินค้าที่เห็น ตอบเป็น JSON เท่านั้น: {"brand":"...","model":"...","code":"...","detail":"..."} ถ้าไม่มีข้อมูลให้ใส่ ""',
          },
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        ],
      },
    ],
    config: { maxOutputTokens: 200, temperature: 0 },
  })

  // ขั้น 2: ค้นหาใน spenderclub.com — ใช้คำถามลูกค้าก่อน ถ้าไม่มีใช้ข้อมูลจากรูป
  let webContext = ''
  try {
    const raw = extractRes.text?.trim() ?? ''
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim())
    const imageQuery = [json.brand, json.model, json.code].filter(Boolean).join(' ')
    const query = userQuestion || imageQuery
    if (query) {
      const webText = await searchSpenderClub(query)
      if (webText) webContext = `\n\nข้อมูลจาก spenderclub.com:\n${webText}`
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'image.web_search', query }))
    }
  } catch {
    // ถ้า extract หรือ search ล้มเหลว ข้ามไปตอบจาก FAQ เฉยๆ
  }

  // ขั้น 3: ตอบลูกค้าโดยใช้ข้อมูลรูป + เว็บ + FAQ
  const systemPrompt = buildSystemPrompt(
    'น้องใจดี',
    'Spender Club',
    faqText,
    DEFAULT_REPLY,
    'สุภาพ formal ลงท้ายด้วย "ค่ะ" เสมอ'
  )

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: userQuestion
              ? `ลูกค้าส่งรูปภาพสินค้ามา พร้อมคำถามว่า: "${userQuestion}" ตอบเฉพาะสิ่งที่ถามเท่านั้น ห้ามแต่งข้อมูลเพิ่มเอง`
              : 'ลูกค้าส่งรูปภาพสินค้ามา อ่านข้อมูลจากรูปและตอบสิ่งที่เห็น ห้ามแต่งข้อมูลเพิ่มเอง',
          },
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        ],
      },
    ],
    config: {
      systemInstruction: `${systemPrompt}${webContext}`,
      temperature: 1.0,
      maxOutputTokens: 1024,
    },
  })

  const finishReason = response.candidates?.[0]?.finishReason
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'gemini.image_reply',
      latencyMs: Date.now() - startTime,
      finishReason: finishReason ?? 'unknown',
      hasWebContext: !!webContext,
    })
  )

  if (finishReason === 'MAX_TOKENS') return API_ERROR_REPLY

  const reply = response.text?.trim()
  return reply || API_ERROR_REPLY
}
