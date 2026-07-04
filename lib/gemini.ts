import { GoogleGenAI } from '@google/genai'
import { buildSystemPrompt } from './prompts'
import { searchSpenderSites, searchSpenderRecommend } from './websearch'
import type { Turn } from './history'

const MODEL = 'gemini-2.5-flash'

const RECOMMEND_RE = /รุ่นไหนดี|แนะนำ|เหมาะก[ับ]|เปรียบเทียบ|ต่างกัน|เหมือนกัน|ดีกว่า|ราคาถูกกว่า|ราคาไม่เกิน|งบ.{0,15}บาท|ซื้อรุ่นไหน|เลือกรุ่น|เหมาะสำหรับ|ใช้กับอะไร|เหมาะกับงาน/i

function isRecommendQuestion(text: string): boolean {
  return RECOMMEND_RE.test(text)
}

const DEFAULT_REPLY = '[NOT_FOUND]'
const API_ERROR_REPLY = 'ขออภัยค่ะ น้องใจดีไม่พบข้อมูล ต้องการติดต่อแอดมินแจ้งได้เลยนะคะ'

const SEARCH_TOOL = {
  functionDeclarations: [
    {
      name: 'search_spender_specs',
      description:
        'ค้นหาข้อมูลสเปก ฟังก์ชัน คู่มือ ราคา หรือวิธีแก้ปัญหาวิทยุสื่อสาร SPENDER จาก spenderclub.com และ spendernetwork.com เท่านั้น ห้ามค้นจากแหล่งอื่น ต้องเรียกทุกครั้งที่ไม่เจอคำตอบใน FAQ',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'คำค้นหาที่สกัดจากคำถามลูกค้า เช่น "TC-11HW TC-15HW เปรียบเทียบ สเปก"',
          },
        },
        required: ['query'],
      },
    },
  ],
}

export async function generateReply(
  userMessage: string,
  faqText: string,
  history: Turn[] = [],
  handoffMsg: string = ''
): Promise<string> {
  const startTime = Date.now()
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })

  const systemPrompt = buildSystemPrompt(
    'น้องใจดี',
    'Spender Club',
    faqText,
    DEFAULT_REPLY,
    'สุภาพ เป็นมิตร ลงท้ายด้วย "ค่ะ" เสมอ',
    handoffMsg
  )

  const contents = [
    ...history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user' as const, parts: [{ text: userMessage }] },
  ]

  // Call 1 — Gemini ตัดสินใจว่าต้องค้นเว็บไหม
  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: systemPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [SEARCH_TOOL] as any,
      temperature: 1.0,
      maxOutputTokens: 1024,
    },
  })

  const parts = response.candidates?.[0]?.content?.parts ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fcPart = parts.find((p: any) => p.functionCall) as any

  if (fcPart?.functionCall?.name === 'search_spender_specs') {
    const query = (fcPart.functionCall.args?.query ?? userMessage) as string

    let searchText = ''
    let searchUrl = ''
    try {
      const searchFn = isRecommendQuestion(userMessage) ? searchSpenderRecommend : searchSpenderSites
      const result = await searchFn(query)
      searchText = result.text
      searchUrl = result.url
    } catch { /* search ล้มเหลว — Gemini จะตอบจาก FAQ */ }

    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'info', event: 'search_spender_specs',
      query, hasResult: !!searchText, url: searchUrl,
    }))

    // Call 2 — ส่งผลค้นหากลับให้ Gemini สรุปตอบ
    const updatedContents = [
      ...contents,
      { role: 'model' as const, parts: [fcPart] },
      {
        role: 'user' as const,
        parts: [{
          functionResponse: {
            name: 'search_spender_specs',
            response: {
              content: searchText || 'ไม่พบข้อมูลจากการค้นหา',
              url: searchUrl || '',
            },
          },
        }],
      },
    ]

    const finalResponse = await ai.models.generateContent({
      model: MODEL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contents: updatedContents as any,
      config: {
        systemInstruction: systemPrompt,
        temperature: 1.0,
        maxOutputTokens: 1024,
      },
    })

    const finishReason2 = finalResponse.candidates?.[0]?.finishReason
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'info', event: 'gemini.search_reply',
      latencyMs: Date.now() - startTime, finishReason: finishReason2, query,
    }))

    if (finishReason2 === 'MAX_TOKENS') return DEFAULT_REPLY
    return finalResponse.text?.trim() || DEFAULT_REPLY
  }

  const usage = response.usageMetadata
  const finishReason = response.candidates?.[0]?.finishReason

  console.log(JSON.stringify({
    ts: new Date().toISOString(), level: 'info', event: 'gemini.reply',
    latencyMs: Date.now() - startTime, finishReason: finishReason ?? 'unknown',
    textLength: response.text?.length ?? 0,
    thoughtsTokenCount: usage?.thoughtsTokenCount ?? 0,
    candidatesTokenCount: usage?.candidatesTokenCount ?? 0,
    totalTokenCount: usage?.totalTokenCount ?? 0,
  }))

  if (finishReason === 'MAX_TOKENS') return DEFAULT_REPLY
  return response.text?.trim() || DEFAULT_REPLY
}

export async function generateReplyWithImage(
  base64Image: string,
  faqText: string,
  userQuestion?: string
): Promise<string> {
  const startTime = Date.now()
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })

  // ขั้น 1: OCR + ดึงข้อมูลสินค้า
  let ocrText = ''
  let imageQuery = ''
  try {
    const extractRes = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'ดูรูปนี้แล้วตอบเป็น JSON เท่านั้น ไม่ต้องอธิบายเพิ่ม:\n{"brand":"...","model":"...","code":"...","ocrText":"..."}\n- brand/model/code: ยี่ห้อ รุ่น รหัสสินค้าที่เห็น\n- ocrText: ข้อความทุกตัวที่อ่านได้จากรูป\nถ้าไม่มีข้อมูลส่วนไหนให้ใส่ ""',
            },
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
          ],
        },
      ],
      config: { maxOutputTokens: 400, temperature: 0 },
    })

    const raw = extractRes.text?.trim() ?? ''
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim())
    ocrText = json.ocrText ?? ''
    imageQuery = [json.brand, json.model, json.code].filter(Boolean).join(' ')
  } catch { /* extract ล้มเหลว */ }

  // ขั้น 2: ค้นหาจาก Serper
  let webContext = ''
  try {
    const query = userQuestion || imageQuery
    if (query) {
      const { text: webText, url: webUrl } = await searchSpenderSites(query)
      if (webText) {
        webContext = `\n\nข้อมูลจาก spenderclub.com:\n${webText}\nลิงก์อ้างอิง: ${webUrl}`
      }
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'image.web_search', query }))
    }
  } catch { /* ข้ามถ้า search ล้มเหลว */ }

  // ขั้น 3: ตอบลูกค้า
  const thaiHour = (new Date().getUTCHours() + 7) % 24
  const imgHandoffMsg =
    thaiHour >= 18 || thaiHour < 8
      ? 'ขณะนี้อยู่นอกเวลาทำการ รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานให้บริการในเวลาทำการ 08:00–17:00 น. ค่ะ'
      : 'รอแอดมินติดต่อกลับนะคะ 🙏 ทีมงานกำลังดูแลท่านอยู่ค่ะ'

  const systemPrompt = buildSystemPrompt(
    'น้องใจดี',
    'Spender Club',
    faqText,
    DEFAULT_REPLY,
    'สุภาพ เป็นมิตร ลงท้ายด้วย "ค่ะ" เสมอ',
    imgHandoffMsg
  )

  const ocrContext = ocrText ? `\n\nข้อความที่อ่านได้จากรูป (OCR):\n${ocrText}` : ''

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: userQuestion
              ? `ลูกค้าส่งรูปภาพมา พร้อมคำถามว่า: "${userQuestion}" ตอบเฉพาะสิ่งที่ถามเท่านั้น ห้ามแต่งข้อมูลเพิ่มเอง`
              : 'ลูกค้าส่งรูปภาพมา อ่านข้อมูลจากรูปและตอบสิ่งที่เห็น ห้ามแต่งข้อมูลเพิ่มเอง',
          },
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        ],
      },
    ],
    config: {
      systemInstruction: `${systemPrompt}${webContext}${ocrContext}`,
      temperature: 1.0,
      maxOutputTokens: 1024,
    },
  })

  const finishReason = response.candidates?.[0]?.finishReason
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level: 'info', event: 'gemini.image_reply',
    latencyMs: Date.now() - startTime, finishReason: finishReason ?? 'unknown',
    hasWebContext: !!webContext, hasOcrText: !!ocrText, ocrLength: ocrText.length,
  }))

  if (finishReason === 'MAX_TOKENS') return API_ERROR_REPLY
  return response.text?.trim() || API_ERROR_REPLY
}
