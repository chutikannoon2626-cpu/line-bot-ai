'use client'
import { useState } from 'react'
import type { CSSProperties } from 'react'
import * as XLSX from 'xlsx'

type Tab = 'images' | 'errors'

type ImageFailureEntry = {
  ts: string
  userId: string
  latencyMs: number
  imageCount: number
  channel: 'line' | 'facebook'
  reason: string
}

type WebhookErrorEntry = {
  ts: string
  userId: string
  channel: 'line' | 'facebook'
  type: string
  detail: string
}

function formatThai(ts: string): string {
  return new Date(ts).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function reasonLabel(reason: string): string {
  if (reason === 'gemini_timeout') return 'หมดเวลา (Gemini ช้า)'
  if (reason === 'model_unclear')  return 'โมเดลตอบไม่ชัดเจน (ไม่ใช่ timeout)'
  return reason
}

function typeLabel(type: string): string {
  if (type === 'gemini_text_timeout') return 'หมดเวลา (ข้อความทั่วไป, 20 วิ)'
  if (type === 'reply_push_failed')   return 'ส่งข้อความไม่สำเร็จ (reply+push ล้มเหลว)'
  if (type === 'webhook_error')       return 'Error ทั่วไป (ไม่ทราบสาเหตุ)'
  return type
}

const btn = (color = '#1a3a5c'): CSSProperties => ({
  padding: '8px 20px', background: color, color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
})
const outBtn = (color = '#c00'): CSSProperties => ({
  padding: '5px 14px', background: '#fff', color,
  border: `1px solid ${color}`, borderRadius: 4, cursor: 'pointer', fontSize: 13,
})
const tabStyle = (active: boolean): CSSProperties => ({
  padding: '8px 18px', cursor: 'pointer', fontWeight: active ? 'bold' : 'normal',
  borderTop: 'none', borderLeft: 'none', borderRight: 'none',
  borderBottom: active ? '3px solid #1a3a5c' : '3px solid transparent',
  color: active ? '#1a3a5c' : '#666', background: 'none', fontSize: 14,
})

function ChBadge({ ch }: { ch: string }) {
  const cfg: Record<string, { bg: string; label: string }> = {
    line:     { bg: '#06c755', label: 'LINE' },
    facebook: { bg: '#1877f2', label: 'FB' },
  }
  const s = cfg[ch] ?? { bg: '#888', label: ch }
  return (
    <span style={{ display: 'inline-block', background: s.bg, color: '#fff', fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 4, letterSpacing: 0.3 }}>
      {s.label}
    </span>
  )
}

function ReasonBadge({ reason }: { reason: string }) {
  const isTimeout = reason === 'gemini_timeout'
  return (
    <span style={{
      display: 'inline-block', fontSize: 12, fontWeight: 'bold', padding: '3px 10px', borderRadius: 12,
      background: isTimeout ? '#fff0f0' : '#eef4ff',
      color: isTimeout ? '#c00' : '#1a5c9e',
    }}>
      {reasonLabel(reason)}
    </span>
  )
}

function TypeBadge({ type }: { type: string }) {
  const cfg: Record<string, { bg: string; color: string }> = {
    gemini_text_timeout: { bg: '#fff0f0', color: '#c00' },
    reply_push_failed:   { bg: '#fff8e1', color: '#a06a00' },
    webhook_error:       { bg: '#f3e8ff', color: '#7c3aed' },
  }
  const s = cfg[type] ?? { bg: '#eee', color: '#555' }
  return (
    <span style={{ display: 'inline-block', fontSize: 12, fontWeight: 'bold', padding: '3px 10px', borderRadius: 12, background: s.bg, color: s.color }}>
      {typeLabel(type)}
    </span>
  )
}

function exportImagesXLSX(rows: ImageFailureEntry[]): void {
  const headers = ['เวลา', 'ช่องทาง', 'จำนวนรูป', 'เวลาที่ใช้ (วิ)', 'สาเหตุ']
  const aoa = rows.map(r => [formatThai(r.ts), r.channel, String(r.imageCount), (r.latencyMs / 1000).toFixed(1), reasonLabel(r.reason)])
  const ws = XLSX.utils.aoa_to_sheet([headers, ...aoa])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'image_failures')
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const blob = new Blob([body], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `image_failures_${new Date().toISOString().slice(0, 10)}.xlsx`; a.click()
  URL.revokeObjectURL(url)
}

function exportErrorsXLSX(rows: WebhookErrorEntry[]): void {
  const headers = ['เวลา', 'ช่องทาง', 'ประเภท', 'รายละเอียด']
  const aoa = rows.map(r => [formatThai(r.ts), r.channel, typeLabel(r.type), r.detail])
  const ws = XLSX.utils.aoa_to_sheet([headers, ...aoa])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'webhook_errors')
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const blob = new Blob([body], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `webhook_errors_${new Date().toISOString().slice(0, 10)}.xlsx`; a.click()
  URL.revokeObjectURL(url)
}

const TH = ({ children, center, w }: { children: React.ReactNode; center?: boolean; w?: number }) => (
  <th style={{
    padding: '10px 14px', textAlign: center ? 'center' : 'left',
    color: '#888', fontWeight: 600, fontSize: 12,
    width: w, background: '#f5f7fa',
    borderBottom: '1px solid #e0e0e0', whiteSpace: 'nowrap',
  }}>
    {children}
  </th>
)
const TD = ({ children, center, muted }: { children: React.ReactNode; center?: boolean; muted?: boolean }) => (
  <td style={{
    padding: '10px 14px', textAlign: center ? 'center' : 'left',
    color: muted ? '#aaa' : undefined, fontSize: 13, verticalAlign: 'middle',
  }}>
    {children}
  </td>
)

export default function ImageFailuresAdminPage() {
  const [key, setKey]       = useState('')
  const [authed, setAuthed] = useState(false)
  const [tab, setTab]       = useState<Tab>('images')
  const [loading, setLoading]   = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError]       = useState('')

  // Tab 1 — รูปภาพตอบไม่ทัน (เรื่องที่ 56/57 เดิม ไม่เปลี่ยน logic เลย)
  const [failures, setFailures] = useState<ImageFailureEntry[]>([])
  const apiUrl = () => `/api/admin/image-failures?key=${encodeURIComponent(key)}`

  // Tab 2 — Error อื่นๆ (ใหม่ เรื่องที่ 61)
  const [webhookErrors, setWebhookErrors] = useState<WebhookErrorEntry[]>([])
  const [errorsLoaded, setErrorsLoaded]   = useState(false)
  const [errorsLoading, setErrorsLoading] = useState(false)
  const errorsApiUrl = () => `/api/admin/webhook-errors?key=${encodeURIComponent(key)}`

  async function login() {
    setLoading(true); setError('')
    const res = await fetch(apiUrl())
    if (res.ok) {
      const d = await res.json() as { failures: ImageFailureEntry[] }
      setFailures(d.failures); setAuthed(true)
    } else { setError('รหัสผ่านไม่ถูกต้อง') }
    setLoading(false)
  }

  async function refresh() {
    setLoading(true)
    if (tab === 'errors') {
      await loadWebhookErrors()
    } else {
      const res = await fetch(apiUrl())
      if (res.ok) {
        const d = await res.json() as { failures: ImageFailureEntry[] }
        setFailures(d.failures)
      }
    }
    setLoading(false)
  }

  async function clearList() {
    if (!confirm('ล้างรายการทั้งหมด?')) return
    setClearing(true)
    if (tab === 'errors') {
      await fetch(errorsApiUrl(), { method: 'DELETE' })
      setWebhookErrors([])
    } else {
      await fetch(apiUrl(), { method: 'DELETE' })
      setFailures([])
    }
    setClearing(false)
  }

  async function loadWebhookErrors() {
    setErrorsLoading(true)
    const res = await fetch(errorsApiUrl())
    if (res.ok) {
      const d = await res.json() as { errors: WebhookErrorEntry[] }
      setWebhookErrors(d.errors)
    }
    setErrorsLoaded(true)
    setErrorsLoading(false)
  }

  async function switchToErrors() {
    setTab('errors')
    if (!errorsLoaded) await loadWebhookErrors()
  }

  const timeoutCount = failures.filter(f => f.reason === 'gemini_timeout').length
  const unclearCount = failures.length - timeoutCount

  // ── Login ──
  if (!authed) return (
    <div style={{ maxWidth: 400, margin: '100px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>
      <h2 style={{ color: '#1a3a5c' }}>🔐 น้องใจดี — Admin</h2>
      <p style={{ color: '#666', fontSize: 13 }}>ใส่รหัสผ่านผู้ดูแลระบบ</p>
      <input
        type="password" placeholder="รหัสผ่าน" value={key}
        onChange={e => setKey(e.target.value)} onKeyDown={e => e.key === 'Enter' && login()}
        style={{ width: '100%', padding: 10, marginBottom: 10, fontSize: 14, boxSizing: 'border-box', borderRadius: 4, border: '1px solid #ccc' }}
      />
      {error && <p style={{ color: 'red', margin: '4px 0 12px' }}>{error}</p>}
      <button onClick={login} disabled={loading} style={btn()}>
        {loading ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ'}
      </button>
    </div>
  )

  return (
    <div style={{ maxWidth: 900, margin: '40px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ color: '#1a3a5c', margin: 0 }}>🛠️ ตรวจสอบปัญหาระบบ</h2>
        <button onClick={refresh} disabled={loading || errorsLoading} style={btn()}>
          {loading || errorsLoading ? 'กำลังโหลด...' : '🔄 รีเฟรช'}
        </button>
      </div>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>LINE OA · Facebook — แสดง 100 รายการล่าสุด</p>

      {/* Tab bar */}
      <div style={{ borderBottom: '1px solid #ddd', marginBottom: 20, display: 'flex' }}>
        <button style={tabStyle(tab === 'images')} onClick={() => setTab('images')}>
          🖼️ รูปภาพตอบไม่ทัน ({failures.length})
        </button>
        <button style={tabStyle(tab === 'errors')} onClick={switchToErrors}>
          ⚠️ Error อื่นๆ ({webhookErrors.length})
        </button>
      </div>

      {/* ── Tab 1: รูปภาพตอบไม่ทัน (เดิม ไม่เปลี่ยน) ── */}
      {tab === 'images' && (
        <>
          <p style={{ color: '#666', fontSize: 13, marginBottom: 4 }}>
            เคสที่ตอบ &quot;ระบบกำลังประมวลผลนานกว่าปกติ&quot; หลังลูกค้าส่งรูป+ข้อความตามมาเร็ว (LINE/Facebook)
          </p>
          <p style={{ color: '#999', fontSize: 12, marginBottom: 20 }}>
            รวม {failures.length} รายการ — หมดเวลาจริง {timeoutCount} · โมเดลตอบไม่ชัดเจน {unclearCount}
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
            <button onClick={() => exportImagesXLSX(failures)} disabled={failures.length === 0} style={outBtn('#1a3a5c')}>
              ⬇ Export Excel
            </button>
            <button onClick={clearList} disabled={clearing || failures.length === 0} style={outBtn()}>
              ล้างทั้งหมด
            </button>
          </div>

          {failures.length === 0 ? (
            <p style={{ color: '#999', textAlign: 'center', padding: 40 }}>ยังไม่มีเคสตอบไม่ทัน 🎉</p>
          ) : (
            <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <TH w={170}>เวลา</TH>
                    <TH center w={80}>ช่องทาง</TH>
                    <TH center w={80}>จำนวนรูป</TH>
                    <TH center w={110}>เวลาที่ใช้</TH>
                    <TH>สาเหตุ</TH>
                  </tr>
                </thead>
                <tbody>
                  {failures.map((f, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                      <TD muted>{formatThai(f.ts)}</TD>
                      <TD center><ChBadge ch={f.channel} /></TD>
                      <TD center>{f.imageCount}</TD>
                      <TD center>{(f.latencyMs / 1000).toFixed(1)} วิ</TD>
                      <TD><ReasonBadge reason={f.reason} /></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Tab 2: Error อื่นๆ (ใหม่ เรื่องที่ 61) ── */}
      {tab === 'errors' && (
        <>
          <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
            เคส Gemini timeout ของข้อความทั่วไป (20 วิ) / ส่งข้อความหาลูกค้าไม่สำเร็จ (reply+push ล้มเหลวทั้งคู่) / error อื่นที่ไม่ถูกจับจุดใดเลย
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
            <button onClick={() => exportErrorsXLSX(webhookErrors)} disabled={webhookErrors.length === 0} style={outBtn('#1a3a5c')}>
              ⬇ Export Excel
            </button>
            <button onClick={clearList} disabled={clearing || webhookErrors.length === 0} style={outBtn()}>
              ล้างทั้งหมด
            </button>
          </div>

          {errorsLoading && (
            <p style={{ color: '#999', textAlign: 'center', padding: 40 }}>กำลังโหลด...</p>
          )}
          {!errorsLoading && webhookErrors.length === 0 && (
            <p style={{ color: '#999', textAlign: 'center', padding: 40 }}>ยังไม่มี error ที่บันทึกไว้ 🎉</p>
          )}
          {!errorsLoading && webhookErrors.length > 0 && (
            <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <TH w={170}>เวลา</TH>
                    <TH center w={80}>ช่องทาง</TH>
                    <TH w={200}>ประเภท</TH>
                    <TH>รายละเอียด</TH>
                  </tr>
                </thead>
                <tbody>
                  {webhookErrors.map((e, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                      <TD muted>{formatThai(e.ts)}</TD>
                      <TD center><ChBadge ch={e.channel} /></TD>
                      <TD><TypeBadge type={e.type} /></TD>
                      <TD>{e.detail}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
