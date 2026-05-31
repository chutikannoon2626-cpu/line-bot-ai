import { GoogleGenAI } from '@google/genai'

const DEFAULT_REPLY =
  'ขออภัยค่ะ น้องใจดีไม่มีข้อมูลในส่วนนี้ กรุณาติดต่อทีมงานได้โดยตรงค่ะ'

const PROMPT_TEMPLATE = `<role>
คุณคือน้องใจดี พนักงานบริการลูกค้าของ Spender Club
ร้านจำหน่ายวิทยุสื่อสารและอุปกรณ์สื่อสาร
</role>

<constraints>
- ตอบโดยใช้ข้อมูลใน <faq> เท่านั้น
- ห้ามแต่งราคา เวลา หรือที่ตั้งที่ไม่มีในข้อมูล
- ถ้าไม่มีข้อมูลให้ตอบว่า: "ขออภัยค่ะ น้องใจดีไม่มีข้อมูลในส่วนนี้ กรุณาติดต่อทีมงานได้โดยตรงค่ะ"
- ใช้ภาษาไทย สุภาพ formal ลงท้ายด้วย "ค่ะ" เสมอ
- ตอบสั้นกระชับแต่ครบถ้วน ความยาว 1-3 ประโยค
- ไม่ใช้ emoji
</constraints>

<output_format>
ภาษาไทย ไม่ใช้ markdown ไม่ใช้ bullet points
</output_format>

<faq>
{{CSV_CONTENT}}
</faq>

<question>
{{USER_MESSAGE}}
</question>`

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

export async function getReply(userMessage: string, csvContent: string): Promise<string> {
  const prompt = PROMPT_TEMPLATE.replace('{{CSV_CONTENT}}', csvContent).replace(
    '{{USER_MESSAGE}}',
    userMessage,
  )

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        temperature: 1.0,
        maxOutputTokens: 1024,
      },
    })

    const finishReason = response.candidates?.[0]?.finishReason
    const thoughtsTokenCount = response.usageMetadata?.thoughtsTokenCount
    const candidatesTokenCount = response.usageMetadata?.candidatesTokenCount
    console.log('[gemini] finishReason:', finishReason, 'thoughtsTokenCount:', thoughtsTokenCount, 'candidatesTokenCount:', candidatesTokenCount)

    if (finishReason === 'MAX_TOKENS') {
      return DEFAULT_REPLY
    }

    return response.text ?? DEFAULT_REPLY
  } catch (err) {
    console.error('[gemini] error:', err)
    return DEFAULT_REPLY
  }
}
