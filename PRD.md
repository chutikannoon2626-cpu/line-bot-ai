# PRD · LINE Bot AI · Spender Club

## Goal

Spender Club อยากตอบลูกค้า LINE OA 24 ชม. โดยไม่ต้องแอดมินออนไลน์ตลอดเวลา
บอท AI ตอบเองด้วย FAQ ที่เจ้าของแก้ใน Google Sheet ได้ทันที
เคสที่ซับซ้อน (ใบเสนอราคา, ขายส่ง, ร้องเรียน) → Smart Handoff ส่งให้แอดมินจริง

## Users

- **ลูกค้า** — ทักเข้า LINE OA · ถามเรื่องสินค้า ราคา รุ่น วิธีสั่งซื้อ บริการหลังการขาย
- **เจ้าของ/แอดมิน** — แก้ Google Sheet เมื่อมีสินค้าใหม่ / โปรโมชั่น
- **แอดมิน (Smart Handoff)** — รับ notification ใน LINE group เมื่อลูกค้าต้องการคุยกับคน

## Acceptance criteria

1. ลูกค้าทักข้อความ → บอทตอบภายใน 5 วินาที (จาก FAQ)
2. ลูกค้าถามนอก FAQ → บอทตอบ default reply (ไม่แต่งข้อมูล)
3. ลูกค้าถามด้วย paraphrase → บอทเข้าใจและตอบจาก FAQ
4. ลูกค้าขอใบเสนอราคา / ขายส่ง / ขอแอดมิน → Smart Handoff + แจ้งกลุ่ม
5. Sheet ดึงไม่ได้ชั่วคราว → บอท fallback stale cache / default reply · ไม่ crash
6. Gemini timeout (>8s) → fallback default reply · ลูกค้าไม่รอนาน

## Non-goals

- ❌ Multi-LINE OA
- ❌ Voice input — text only
- ❌ ระบบสั่งซื้อ / checkout ในบอท — ใช้ Smart Handoff แทน
- ❌ Multi-language — ไทยอย่างเดียว

## Smart Handoff triggers (radio shop)

- คุยกับคน, ขอแอดมิน, ขอเจ้าของ
- ฟ้อง, ร้องเรียน, ไม่พอใจ
- ขายส่ง, wholesale, อยากซื้อจำนวนมาก
- ขอใบเสนอราคา, quotation, ขอ quote
- franchise, ตัวแทนจำหน่าย, dealer
- ติดต่อสื่อ, PR, interview
