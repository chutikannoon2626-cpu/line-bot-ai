import { GoogleGenAI } from '@google/genai'
import { buildSystemPrompt } from './prompts'
import { searchSpenderClub } from './websearch'

const MODEL = 'gemini-2.5-flash'

const DEFAULT_REPLY =
  'ขออภัยค่ะ น้องใจดีไม่มีข้อมูลในส่วนนี้ กรุณาติดต่อทีมงานได้โดยตรงค่ะ'

export async function generateReply(
  userMessage: string,
  faqText: string
): Promise<string> {
  const startTime = Date.now()
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })

  const systemPrompt = buildSystemPrompt(
    'น้องใจดี',
    'Spender Club',
    faqText,
    DEFAULT_REPLY,
    'สุภาพ formal ลงท้ายด้วย "ค่ะ" เสมอ'
  )

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: `${systemPrompt}\n\nคำถามลูกค้า: ${userMessage}`,
    config: {
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

  if (finishReason === 'MAX_TOKENS') return DEFAULT_REPLY

  const reply = response.text?.trim()
  return reply || DEFAULT_REPLY
}

export async function generateReplyWithImage(
  base64Image: string,
  faqText: string
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

  // ขั้น 2: ค้นหาใน spenderclub.com ด้วยข้อมูลที่อ่านได้
  let webContext = ''
  try {
    const raw = extractRes.text?.trim() ?? ''
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim())
    const query = [json.brand, json.model, json.code].filter(Boolean).join(' ')
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
            text: `${systemPrompt}${webContext}\n\nลูกค้าส่งรูปภาพสินค้ามา อ่านข้อความ/รุ่น/สเปคจากรูปให้ครบ แล้วตอบตามข้อมูลที่มี`,
          },
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        ],
      },
    ],
    config: { temperature: 1.0, maxOutputTokens: 1024 },
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

  if (finishReason === 'MAX_TOKENS') return DEFAULT_REPLY

  const reply = response.text?.trim()
  return reply || DEFAULT_REPLY
}
