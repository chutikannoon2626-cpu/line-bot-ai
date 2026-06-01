import { GoogleGenAI } from '@google/genai'
import { buildSystemPrompt } from './prompts'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

const MODEL = 'gemini-1.5-flash'

const DEFAULT_REPLY =
  'ขออภัยค่ะ น้องใจดีไม่มีข้อมูลในส่วนนี้ กรุณาติดต่อทีมงานได้โดยตรงค่ะ'

export async function generateReply(
  userMessage: string,
  faqText: string
): Promise<string> {
  const startTime = Date.now()

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
      candidatesCount: response.candidates?.length ?? 0,
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
