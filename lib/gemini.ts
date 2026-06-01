body.events.map(async (event) => {
  if (event.type !== 'message' || !event.message) return

  const msgType = (event.message as { type: string }).type
  const replyToken = event.replyToken as string
  const source = event.source as { type: string; userId?: string }
  const userId = source.userId ?? 'unknown'
  const startTime = Date.now()

  const lineClient = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
  })

  // --- TEXT ---
  if (msgType === 'text') {
    const userMessage = (event.message as { text: string }).text
    // ... โค้ดเดิมทั้งหมด ไม่ต้องเปลี่ยน
  }

  // --- IMAGE ---
  if (msgType === 'image') {
    const imageId = (event.message as { id: string }).id
    try {
      // ดาวน์โหลดรูปจาก Line
      const stream = await lineClient.getMessageContent(imageId)
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk))
      }
      const imageBuffer = Buffer.concat(chunks)
      const base64Image = imageBuffer.toString('base64')

      // ส่งให้ Gemini วิเคราะห์พร้อมข้อมูลสินค้าจาก Sheet
      const faqText = await fetchFAQ()
      const reply = await generateReplyWithImage(base64Image, faqText)

      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: reply }],
      })
    } catch (err) {
      log.error('image.error', { err: (err as Error).message })
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: DEFAULT_REPLY }],
      })
    }
  }
})
