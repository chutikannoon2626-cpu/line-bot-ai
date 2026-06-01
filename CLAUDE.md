# CLAUDE.md — LINE Bot AI · Spender Club

## What we're building

LINE Official Account bot "น้องใจดี" สำหรับ Spender Club · ร้านจำหน่ายวิทยุสื่อสารและอุปกรณ์สื่อสาร
ตอบลูกค้า 24 ชม. โดยใช้ Gemini 2.5 Flash อ่าน FAQ จาก Google Sheet

## Stack — locked

- Next.js 14 App Router + TypeScript
- `@line/bot-sdk` v9 for LINE Messaging API
- `@google/genai` for Gemini 2.5 Flash
- Google Sheet CSV public URL for FAQ
- Vercel for hosting (Hobby tier)
- npm

## Repo conventions

- `app/api/line-webhook/route.ts` — POST handler (verify signature → handoff check → FAQ → Gemini → reply)
- `lib/sheet.ts` — fetch + parse CSV + 60s cache + stale fallback
- `lib/gemini.ts` — call Gemini with system prompt · truncation guard · token logging
- `lib/prompts.ts` — buildSystemPrompt() with Hallucination Guard (guardrails + reasoning protocol)
- `lib/handoff.ts` — Smart Handoff: shouldHandoff() + notifyAdmin()
- `lib/flex-cards.ts` — Flex Message builders (catalogCard, contactCard)
- `lib/log.ts` — structured JSON logging helper

## Env vars (Vercel)

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GEMINI_API_KEY`
- `SHEET_CSV_URL`
- `ADMIN_GROUP_ID` — Smart Handoff target LINE group (optional · graceful skip if unset)

## Google Sheet format

CSV ต้องมี header row: `category,question,answer`
- category: หมวดหมู่ เช่น สินค้า, ราคา, การสั่งซื้อ, บริการหลังการขาย
- question: คำถามอ้างอิง
- answer: คำตอบที่ Gemini จะใช้

## Don'ts

- ❌ Hardcode token/key — use env vars only
- ❌ Skip signature verification — security risk
- ❌ Skip timeout on Gemini — webhook must reply within 10s
- ❌ Cache FAQ >60s — owner edits Sheet ต้องสะท้อนเร็ว
- ❌ Log userMessage content — PII · log metadata เท่านั้น
- ❌ ใช้ `NextResponse.json()` ใน webhook — ต้องใช้ `new Response()` เพื่อ return 200 เร็ว
