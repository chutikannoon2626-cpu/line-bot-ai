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
  handoffMsg: string = '',
  channel: 'line' | 'facebook' | 'web' = 'web',
  abortSignal?: AbortSignal
): Promise<string> {
  const startTime = Date.now()
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })

  const systemPrompt = buildSystemPrompt(
    'น้องใจดี',
    'Spender Club',
    faqText,
    DEFAULT_REPLY,
    'สุภาพ เป็นมิตร ลงท้ายด้วย "ค่ะ" เสมอ',
    handoffMsg,
    channel
  )

  const contents = [
    ...history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user' as const, parts: [{ text: userMessage }] },
  ]

  // Call 1 — Gemini ตัดสินใจว่าต้องค้นเว็บไหม
  // maxOutputTokens เพิ่มจาก 1024 + thinkingBudget จำกัดไว้ที่ 1024 กันไม่ให้ "คิด" กินโควตาจนไม่เหลือที่เขียนคำตอบ (MAX_TOKENS)
  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: systemPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [SEARCH_TOOL] as any,
      temperature: 1.0,
      maxOutputTokens: 3072,
      thinkingConfig: { thinkingBudget: 1024 },
      abortSignal,
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
        maxOutputTokens: 3072,
        thinkingConfig: { thinkingBudget: 1024 },
        abortSignal,
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
  userQuestion?: string,
  channel: 'line' | 'facebook' = 'line'
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
    imgHandoffMsg,
    channel
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

export type ImageIntent =
  | { kind: 'product'; product: string }
  | { kind: 'other'; summary: string; confirmMessage: string }
  | { kind: 'handoff' }
  | { kind: 'unclear' }

// วิเคราะห์รูปที่ลูกค้าส่งมาแบบไม่มีข้อความ/caption ประกอบ (LINE/Facebook เท่านั้น) — เดิมเดา
// แค่ยี่ห้อ/รุ่นสินค้าอย่างเดียว ทำให้รูปประเภทอื่น (จอ error, ฉลาก/หน้าจอ IMEI, สกรีนช็อตแอป/เว็บ,
// เอกสารส่งซ่อม) ไม่ถูกจับเลย ตอนนี้ให้ Gemini จำแนกกว้างขึ้น: ถ้าเป็นรูปสินค้าชัดเจนยังคง
// ส่งชื่อสินค้ากลับมาเหมือนเดิม (ใช้ imageIntentCard ต่อได้) ถ้าเป็นรูปอื่นที่พอเข้าใจเจตนาได้
// ให้สรุปสั้นๆ + แต่งประโยคถามยืนยันกับลูกค้ากลับมาเลย (ไม่เดาคำตอบเอง แค่สรุปสิ่งที่เห็นแล้วถาม)
// (2026-08-01)
// รับได้หลายรูปพร้อมกัน (2026-08-05, ส่วนที่ 1 ของบั๊กรูปหายเวลาส่งหลายรูปติดกัน) — ถ้ามีมากกว่า
// 1 รูป ให้ Gemini สรุปแยกรายรูป ถ้าทุกรูปเป็นสินค้าตัวเดียวกันชัดเจนถึงจะใช้ kind:"product" ได้
// ถ้าเป็นสินค้าคนละตัว/คนละประเภทกัน ให้ตกไป kind:"other" พร้อมสรุปแยกรายรูปแทน กันเมนู 3 ปุ่ม
// (ผูกกับสินค้าเดียว) ไปจับคู่ผิดกับรูปที่ไม่ตรงกัน
export async function analyzeImageIntent(base64Images: string[]): Promise<ImageIntent> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })
  const multi = base64Images.length > 1
  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: [{
        role: 'user',
        parts: [
          {
            text: `ก่อนตอบ ให้จำแนกแต่ละรูปเป็นประเภทหนึ่งใน 6 แบบนี้ก่อนเสมอ (ใช้พิจารณาภายในเท่านั้น ห้ามเขียนชื่อประเภท A-F ออกมาในคำตอบ):
A = ป้าย/สติกเกอร์ S/N หรือ IMEI ติดอยู่บนตัวเครื่องโดยตรง
B = หน้าจอเมนู/การตั้งค่าทั่วไปของอุปกรณ์ (ไม่ใช่ข้อมูลระบุตัวตนเครื่อง)
C = หน้าจอแสดงรหัสระบุเครื่อง (ICCID/IMEI) ผ่านซอฟต์แวร์/แอปในเครื่อง
D = ภาพ error หรือปัญหาการใช้งาน
E = ภาพที่มีข้อความ/แบบฟอร์ม/บทสนทนาของบุคคลที่สาม สังเกตจากสัญญาณเหล่านี้ (มีข้อใดข้อหนึ่งก็นับเป็น E แล้ว ไม่ต้องครบทุกข้อ):
   · มีกรอบข้อความ/ฟองแชท (chat bubble), รูปโปรไฟล์วงกลม (avatar), หรือ timestamp แบบแอปแชท (เช่น LINE/Messenger/SMS)
   · มีลิงก์ URL แบบย่อหรือ redirect (เช่น bit.ly, tinyurl, ลิงก์ที่ดูเหมือนถูกปลอมมาให้กดยืนยัน/ล็อกอิน)
   · มีข้อความขอข้อมูลส่วนตัว เช่น ที่อยู่, เลขบัตรประชาชน, รหัสผ่าน/OTP, เลขบัญชีธนาคาร
   · เป็นเอกสาร/ฟอร์มที่มีชื่อ-ข้อมูลส่วนตัวของบุคคลอื่น (ไม่ใช่ตัวเครื่อง/สินค้า) ปนอยู่
F = รูปสินค้าทั่วไป ไม่มีข้อความสำคัญปน

กฎการตอบตามประเภท:
- A: ต้องอ่านตัวเลขให้ครบทุกหลัก ห้ามตัดหรือเดา ถ้าไม่มั่นใจ (เบลอ/แสงสะท้อน/ตัวเล็กจนอ่านไม่ชัดบางหลัก) ให้บอกลูกค้าตรงๆ ว่าอ่านไม่ชัดตรงไหน แล้วขอให้ยืนยัน/ถ่ายใหม่ ห้ามเดาหลักที่อ่านไม่ออก
- B: บอกสิ่งที่เห็นตรงไปตรงมา ความเสี่ยงต่ำ ไม่ต้องระวังเป็นพิเศษ
- C: จับคู่ label กับค่าตัวเลขให้ตรงกันเป๊ะ (เช่น ICCID คู่กับเลข ICCID, IMEI คู่กับเลข IMEI) ห้ามเดาหรือสลับคู่กัน ถ้ามีหลายค่าปนกันให้แยกระบุเป็นรายการ
- D: สรุปอาการที่เห็นให้แม่นยำครบถ้วน
- E: **สำคัญที่สุด ตัดสินก่อนประเภทอื่นเสมอ** — ถ้ามีรูปที่เข้าสัญญาณข้อใดข้อหนึ่งของประเภท E ด้านบนปนอยู่แม้แต่รูปเดียวในชุดที่ส่งมา ห้ามอ่าน/สรุป/เปิดเผยเนื้อหาส่วนบุคคลของบุคคลที่สามในรูปเด็ดขาด ให้ตอบ {"kind":"handoff"} ทันทีคำเดียว ไม่สนใจว่ารูปอื่นในชุดเป็นประเภทไหน
- F: ระบุยี่ห้อ/รุ่นสินค้าให้ชัดเจนที่สุดเท่าที่ทำได้

ลำดับความสำคัญเมื่อมีหลายรูปคนละประเภทปนกันในชุดเดียวกัน: E > A/C > D > B/F (ประเภทที่มาก่อนในลำดับนี้ตัดสินการตอบทั้งชุด — เช่นมี E ปนอยู่กับ F ให้ตอบ handoff ทันที ไม่ต้องพิจารณารูป F เลย)

ตอบเป็น JSON เท่านั้น ไม่ต้องอธิบายเพิ่ม ห้ามแต่งข้อมูลที่ไม่เห็นในรูป ดูรูปทั้งหมดนี้ (${base64Images.length} รูป) แล้วตอบตามเงื่อนไขนี้:

0) ถ้ามีรูปประเภท E (มีข้อความ/แบบฟอร์ม/บทสนทนาของบุคคลที่สาม) ปนอยู่แม้แต่รูปเดียว ให้ตอบทันทีโดยไม่ต้องพิจารณารูปอื่นเลย:
{"kind":"handoff"}

1) ถ้าไม่มีรูปประเภท E เลย และทุกรูปเป็นรูปสินค้าแบรนด์ SPENDER ตัวเดียวกันชัดเจน (ประเภท F, วิทยุสื่อสาร, อุปกรณ์เสริม, อะไหล่, แท่นชาร์จ ฯลฯ) ระบุยี่ห้อ/รุ่นได้ชัดเจน (ไม่มีข้อความ error/คำเตือน หรือหน้าจอ/ฉลากแสดง IMEI ปนอยู่เลยสักรูป):
{"kind":"product","product":"Spender TC-4M"}

2) ถ้าไม่เข้าเงื่อนไข 0 หรือ 1 แต่พอมองออกว่าเป็นอะไร (ประเภท A/B/C/D/F ที่ไม่ใช่สินค้าเดียวกันชัดเจน ไม่ว่าจะเป็นแบรนด์ไหน สินค้าประเภทไหน หรือสถานการณ์แบบใดก็ตาม) **หรือมีมากกว่า 1 รูปและแต่ละรูปเป็นคนละสินค้า/คนละเรื่องกัน** — ให้สรุปสั้นๆ ว่าเห็นอะไร (ภาษาไทย ตามกฎประเภทด้านบน) แล้วแต่งเป็นประโยคคำถามยืนยันกับลูกค้า โทนสุภาพเป็นมิตรแบบผู้หญิง ลงท้ายด้วย "ค่ะ"/"คะ" เสมอ ถามว่าต้องการให้ช่วยเรื่องนี้ใช่ไหม ห้ามตอบคำถามหรือแนะนำวิธีแก้ใดๆ เอง แค่สรุป+ถามยืนยันเท่านั้น เช่น:
{"kind":"other","summary":"เครื่อง TC-5M ขึ้นข้อความ login timeout","confirmMessage":"เห็นว่าเครื่อง TC-5M ขึ้นข้อความ \\"login timeout\\" ใช่ไหมคะ ต้องการให้น้องใจดีช่วยดูเรื่องนี้ใช่ไหมคะ 😊"}
ถ้าระบุชื่อสินค้า/อุปกรณ์ได้ชัดเจน ให้ขึ้นต้นประโยคด้วย "สินค้าเป็น..." แทน "เห็นว่า..." เช่น:
{"kind":"other","summary":"อะแดปเตอร์ชาร์จไฟ SPENDER รุ่น E2452","confirmMessage":"สินค้าเป็นอะแดปเตอร์ชาร์จไฟ SPENDER รุ่น E2452 ใช่ไหมคะ ต้องการให้น้องใจดีช่วยเรื่องนี้ใช่ไหมคะ 😊"}
ตัวอย่างสินค้าแบรนด์อื่น: {"kind":"other","summary":"อุปกรณ์ชาร์จแบตเตอรี่ในรถยนต์ ยี่ห้อ kaiwa รุ่น SP-DX5 Plus","confirmMessage":"สินค้าเป็นอุปกรณ์ชาร์จแบตเตอรี่ในรถยนต์ ยี่ห้อ kaiwa รุ่น SP-DX5 Plus ใช่ไหมคะ ต้องการให้น้องใจดีช่วยเรื่องนี้ใช่ไหมคะ 😊"}
ตัวอย่างประเภท A (ป้าย S/N ไม่มั่นใจบางหลัก): {"kind":"other","summary":"ฉลาก S/N อ่านได้ B26023022S018876 แต่หลักท้ายเบลอไม่ชัด","confirmMessage":"เห็นฉลาก S/N เป็น B26023022S018876 (หลักท้ายภาพเบลอนิดหน่อย รบกวนยืนยันหรือถ่ายใหม่ให้ชัดขึ้นได้ไหมคะ) ใช่ไหมคะ 😊"}
${multi ? `ตัวอย่างหลายรูปคนละเรื่องกัน: {"kind":"other","summary":"รูปที่ 1: ฉลาก S/N รุ่น TC-11HW, รูปที่ 2: หน้าจอ error login timeout","confirmMessage":"เห็นรูปที่ 1 เป็นฉลาก S/N รุ่น TC-11HW และรูปที่ 2 เป็นหน้าจอขึ้น \\"login timeout\\" ใช่ไหมคะ ต้องการให้น้องใจดีช่วยเรื่องนี้ใช่ไหมคะ 😊"} — ถ้ามีมากกว่า 1 รูปเสมอให้ระบุ "รูปที่ 1", "รูปที่ 2" ... แยกในทั้ง summary และ confirmMessage ห้ามรวมเป็นก้อนเดียวจนแยกไม่ออกว่ารูปไหนคืออะไร` : ''}

3) ใช้ "unclear" เฉพาะกรณีที่รูปไม่ชัด มืด เบลอ หรืออ่าน/มองไม่ออกจริงๆ ว่าเป็นอะไรเลยเท่านั้น (ถ้ามีหลายรูป ต้องอ่านไม่ออกทุกรูปถึงจะใช้ unclear ได้ ถ้าอ่านออกบางรูปให้ใช้ข้อ 2 แทนแล้วบอกว่ารูปไหนอ่านไม่ออก):
{"kind":"unclear"}`,
          },
          ...base64Images.map(img => ({ inlineData: { mimeType: 'image/jpeg', data: img } })),
        ],
      }],
      config: { maxOutputTokens: 800, temperature: 0, thinkingConfig: { thinkingBudget: 300 } },
    })

    const raw = res.text?.trim() ?? ''
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim())

    if (json.kind === 'handoff') {
      return { kind: 'handoff' }
    }
    if (json.kind === 'product' && typeof json.product === 'string' && json.product.trim()) {
      return { kind: 'product', product: json.product.trim() }
    }
    if (json.kind === 'other' && typeof json.confirmMessage === 'string' && json.confirmMessage.trim()) {
      return { kind: 'other', summary: String(json.summary ?? '').trim(), confirmMessage: json.confirmMessage.trim() }
    }
    return { kind: 'unclear' }
  } catch {
    return { kind: 'unclear' }
  }
}

export type ImageWithTextResult =
  | { kind: 'confirm'; summary: string; confirmMessage: string }
  | { kind: 'handoff' }
  | { kind: 'unclear' }

// วิเคราะห์รูป+ข้อความที่ลูกค้าส่งมาพร้อมกัน (LINE: พิมพ์ตามภายใน 5 นาที / Facebook: มี caption)
// เดิมส่งเข้า generateReplyWithImage() ตอบทันที ซึ่งค้นเว็บอัตโนมัติทุกครั้งก่อนแม้คำถามจะไม่เกี่ยวกับ
// สเปกสินค้าเลย (เช่น ขอเข้ากลุ่ม) เสียเวลาโดยเปล่าประโยชน์ — เปลี่ยนเป็นอ่านรูป+ข้อความพร้อมกันแล้ว
// สรุป+ถามยืนยันกลับไปก่อนเสมอ (ไม่เดาคำตอบ) เมื่อลูกค้ายืนยันแล้วค่อยส่งเข้า flow ข้อความปกติ
// (ค้นชีตก่อน ไม่เจอค่อยค้นเว็บ) — ใช้ pattern เดียวกับ analyzeImageIntent() แต่รวมข้อความลูกค้า
// เข้าไปในการวิเคราะห์ด้วย ไม่แยก product/other เพราะสรุป+ถามยืนยันเสมอทุกกรณีที่พอเข้าใจได้
// เฉพาะ LINE/Facebook เท่านั้น ไม่แตะ generateReplyWithImage()/analyzeImageIntent() เดิมเลย (2026-08-01)
// รับได้หลายรูปพร้อมกัน (2026-08-05, ส่วนที่ 1 ของบั๊กรูปหายเวลาส่งหลายรูปติดกัน) — ถ้ามีมากกว่า
// 1 รูป ให้ Gemini สรุปแยกรายรูปในทั้ง summary และ confirmMessage
export async function analyzeImageWithText(base64Images: string[], userText: string): Promise<ImageWithTextResult> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' })
  const multi = base64Images.length > 1
  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: [{
        role: 'user',
        parts: [
          {
            text: `ก่อนตอบ ให้จำแนกแต่ละรูปเป็นประเภทหนึ่งใน 6 แบบนี้ก่อนเสมอ (ใช้พิจารณาภายในเท่านั้น ห้ามเขียนชื่อประเภท A-F ออกมาในคำตอบ):
A = ป้าย/สติกเกอร์ S/N หรือ IMEI ติดอยู่บนตัวเครื่องโดยตรง
B = หน้าจอเมนู/การตั้งค่าทั่วไปของอุปกรณ์ (ไม่ใช่ข้อมูลระบุตัวตนเครื่อง)
C = หน้าจอแสดงรหัสระบุเครื่อง (ICCID/IMEI) ผ่านซอฟต์แวร์/แอปในเครื่อง
D = ภาพ error หรือปัญหาการใช้งาน
E = ภาพที่มีข้อความ/แบบฟอร์ม/บทสนทนาของบุคคลที่สาม สังเกตจากสัญญาณเหล่านี้ (มีข้อใดข้อหนึ่งก็นับเป็น E แล้ว ไม่ต้องครบทุกข้อ):
   · มีกรอบข้อความ/ฟองแชท (chat bubble), รูปโปรไฟล์วงกลม (avatar), หรือ timestamp แบบแอปแชท (เช่น LINE/Messenger/SMS)
   · มีลิงก์ URL แบบย่อหรือ redirect (เช่น bit.ly, tinyurl, ลิงก์ที่ดูเหมือนถูกปลอมมาให้กดยืนยัน/ล็อกอิน)
   · มีข้อความขอข้อมูลส่วนตัว เช่น ที่อยู่, เลขบัตรประชาชน, รหัสผ่าน/OTP, เลขบัญชีธนาคาร
   · เป็นเอกสาร/ฟอร์มที่มีชื่อ-ข้อมูลส่วนตัวของบุคคลอื่น (ไม่ใช่ตัวเครื่อง/สินค้า) ปนอยู่
F = รูปสินค้าทั่วไป ไม่มีข้อความสำคัญปน

กฎการตอบตามประเภท:
- A: ต้องอ่านตัวเลขให้ครบทุกหลัก ห้ามตัดหรือเดา ถ้าไม่มั่นใจ (เบลอ/แสงสะท้อน/ตัวเล็กจนอ่านไม่ชัดบางหลัก) ให้บอกลูกค้าตรงๆ ว่าอ่านไม่ชัดตรงไหน แล้วขอให้ยืนยัน/ถ่ายใหม่ ห้ามเดาหลักที่อ่านไม่ออก
- B: บอกสิ่งที่เห็นตรงไปตรงมา ความเสี่ยงต่ำ ไม่ต้องระวังเป็นพิเศษ
- C: จับคู่ label กับค่าตัวเลขให้ตรงกันเป๊ะ (เช่น ICCID คู่กับเลข ICCID, IMEI คู่กับเลข IMEI) ห้ามเดาหรือสลับคู่กัน ถ้ามีหลายค่าปนกันให้แยกระบุเป็นรายการ
- D: สรุปอาการที่เห็นให้แม่นยำครบถ้วน
- E: **สำคัญที่สุด ตัดสินก่อนประเภทอื่นเสมอ** — ถ้ามีรูปที่เข้าสัญญาณข้อใดข้อหนึ่งของประเภท E ด้านบนปนอยู่แม้แต่รูปเดียวในชุดที่ส่งมา ห้ามอ่าน/สรุป/เปิดเผยเนื้อหาส่วนบุคคลของบุคคลที่สามในรูปเด็ดขาด ให้ตอบ {"kind":"handoff"} ทันทีคำเดียว ไม่สนใจว่ารูปอื่นในชุดหรือข้อความลูกค้าเป็นอะไร
- F: ระบุยี่ห้อ/รุ่นสินค้าให้ชัดเจนที่สุดเท่าที่ทำได้

ลำดับความสำคัญเมื่อมีหลายรูปคนละประเภทปนกันในชุดเดียวกัน: E > A/C > D > B/F (ประเภทที่มาก่อนในลำดับนี้ตัดสินการตอบทั้งชุด)

ดูรูปทั้งหมดนี้ (${base64Images.length} รูป) พร้อมข้อความที่ลูกค้าพิมพ์มาด้วย: "${userText}"
ตอบเป็น JSON เท่านั้น ไม่ต้องอธิบายเพิ่ม ห้ามแต่งข้อมูลที่ไม่เห็นในรูปหรือไม่มีในข้อความ ห้ามตอบคำถามหรือแนะนำวิธีแก้ใดๆ เอง แค่สรุปสิ่งที่เห็น+ข้อความ แล้วถามยืนยันเท่านั้น:

0) ถ้ามีรูปประเภท E (มีข้อความ/แบบฟอร์ม/บทสนทนาของบุคคลที่สาม) ปนอยู่แม้แต่รูปเดียว ให้ตอบทันทีโดยไม่ต้องพิจารณารูปอื่นหรือข้อความลูกค้าเลย:
{"kind":"handoff"}

1) ถ้าไม่เข้าเงื่อนไข 0 และพอเข้าใจได้ว่ารูป+ข้อความนี้เกี่ยวกับอะไร (ไม่ว่าจะเป็นถามราคา/สเปกสินค้า, แจ้งปัญหา, ขอเข้า/ลบกลุ่ม, หรือเรื่องอื่นใดก็ตาม) — ให้สรุปสั้นๆ ว่าเห็นอะไรในรูปและลูกค้าต้องการอะไรจากข้อความ (ภาษาไทย ตามกฎประเภทด้านบน) แล้วแต่งเป็นประโยคคำถามยืนยันกับลูกค้า โทนสุภาพเป็นมิตรแบบผู้หญิง ลงท้ายด้วย "ค่ะ"/"คะ" เสมอ เช่น:
{"kind":"confirm","summary":"สินค้า TC-11HW ลูกค้าถามราคา","confirmMessage":"สินค้าเป็น SPENDER TC-11HW ใช่ไหมคะ ต้องการทราบราคาใช่ไหมคะ 😊"}
{"kind":"confirm","summary":"IMEI 868078078912323 ลูกค้าขอเข้ากลุ่ม DOPA BBT","confirmMessage":"เห็น IMEI: 868078078912323 ใช่ไหมคะ ต้องการเพิ่มเข้ากลุ่ม DOPA BBT ใช่ไหมคะ 😊"}
${multi ? `ตัวอย่างหลายรูป: {"kind":"confirm","summary":"รูปที่ 1: ฉลาก S/N รุ่น TC-11HW, รูปที่ 2: ฉลาก S/N รุ่น TC-15HW ลูกค้าขอเข้ากลุ่ม DOPA BBT ทั้งคู่","confirmMessage":"เห็นรูปที่ 1 เป็น TC-11HW และรูปที่ 2 เป็น TC-15HW ใช่ไหมคะ ต้องการเพิ่มเข้ากลุ่ม DOPA BBT ทั้ง 2 เครื่องใช่ไหมคะ 😊"} — ถ้ามีมากกว่า 1 รูปเสมอให้ระบุ "รูปที่ 1", "รูปที่ 2" ... แยกในทั้ง summary และ confirmMessage ห้ามรวมเป็นก้อนเดียวจนแยกไม่ออกว่ารูปไหนคืออะไร` : ''}

2) ใช้ "unclear" เฉพาะกรณีที่ทั้งรูปและข้อความไม่ให้ข้อมูลอะไรเลยจริงๆ (รูปไม่ชัด/มืด/เบลอ ทุกรูป และข้อความก็ไม่มีความหมาย):
{"kind":"unclear"}`,
          },
          ...base64Images.map(img => ({ inlineData: { mimeType: 'image/jpeg', data: img } })),
        ],
      }],
      config: { maxOutputTokens: 800, temperature: 0, thinkingConfig: { thinkingBudget: 300 } },
    })

    const raw = res.text?.trim() ?? ''
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim())

    if (json.kind === 'handoff') {
      return { kind: 'handoff' }
    }
    if (json.kind === 'confirm' && typeof json.confirmMessage === 'string' && json.confirmMessage.trim()) {
      return { kind: 'confirm', summary: String(json.summary ?? '').trim(), confirmMessage: json.confirmMessage.trim() }
    }
    return { kind: 'unclear' }
  } catch {
    return { kind: 'unclear' }
  }
}
