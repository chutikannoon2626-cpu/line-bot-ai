'use client'
import { useState, FormEvent } from 'react'
import type { CSSProperties } from 'react'

interface Rule {
  id: string
  startDate: string
  endDate: string
  label: string
  message: string
  enabled: boolean
}

const btn = (color = '#1a3a5c'): CSSProperties => ({
  padding: '8px 20px', background: color, color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
})
const outBtn = (color = '#1a3a5c'): CSSProperties => ({
  padding: '5px 14px', background: '#fff', color,
  border: `1px solid ${color}`, borderRadius: 4, cursor: 'pointer', fontSize: 13,
})
const card = (on: boolean): CSSProperties => ({
  padding: '12px 16px', marginBottom: 8, borderRadius: 8,
  background: on ? '#fff' : '#f9f9f9',
  border: `2px solid ${on ? '#1a3a5c' : '#ccc'}`,
  opacity: on ? 1 : 0.7,
})
const badge = (on: boolean): CSSProperties => ({
  fontSize: 12, padding: '2px 8px', borderRadius: 10,
  background: on ? '#e8f5e9' : '#eee',
  color: on ? '#2e7d32' : '#999',
})
const input: CSSProperties = { padding: 8, fontSize: 14, borderRadius: 4, border: '1px solid #ccc', width: '100%', boxSizing: 'border-box' }

function formatDate(s: string): string {
  const [y, m, d] = s.split('-')
  return `${d}/${m}/${y}`
}

export default function HolidaysPage() {
  const [key, setKey]           = useState('')
  const [authed, setAuthed]     = useState(false)
  const [rules, setRules]       = useState<Rule[]>([])
  const [startDate, setStart]   = useState('')
  const [endDate, setEnd]       = useState('')
  const [label, setLabel]       = useState('')
  const [message, setMessage]   = useState('')
  const [error, setError]       = useState('')
  const [saving, setSaving]     = useState(false)

  function apiUrl() {
    return `/api/admin/holidays?key=${encodeURIComponent(key)}`
  }

  async function login() {
    setSaving(true); setError('')
    const res = await fetch(apiUrl())
    if (res.ok) { setRules(await res.json()); setAuthed(true) }
    else setError('รหัสผ่านไม่ถูกต้อง')
    setSaving(false)
  }

  async function addRule(e: FormEvent) {
    e.preventDefault()
    if (!startDate || !endDate) { setError('กรุณาเลือกวันที่เริ่มและวันที่สิ้นสุด'); return }
    if (startDate > endDate) { setError('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด'); return }
    if (!label.trim()) { setError('กรุณาใส่ชื่อวันหยุด'); return }
    if (!message.trim()) { setError('กรุณาใส่ข้อความแจ้งลูกค้า'); return }
    setSaving(true); setError('')
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, label, message }),
    })
    if (res.ok) {
      const newRule = await res.json() as Rule
      setRules(r => [...r, newRule])
      setStart(''); setEnd(''); setLabel(''); setMessage('')
    }
    setSaving(false)
  }

  async function toggle(id: string, enabled: boolean) {
    await fetch(apiUrl(), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    })
    setRules(r => r.map(x => x.id === id ? { ...x, enabled } : x))
  }

  async function remove(id: string) {
    await fetch(apiUrl(), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setRules(r => r.filter(x => x.id !== id))
  }

  if (!authed) {
    return (
      <div style={{ maxWidth: 400, margin: '100px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>
        <h2 style={{ color: '#1a3a5c' }}>🔐 น้องใจดี — Admin Holidays</h2>
        <p style={{ color: '#666', fontSize: 13 }}>ใส่รหัสผ่านผู้ดูแลระบบ</p>
        <input
          type="password" placeholder="รหัสผ่าน" value={key}
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()}
          style={{ ...input, marginBottom: 10 }}
        />
        {error && <p style={{ color: 'red', margin: '4px 0 12px' }}>{error}</p>}
        <button onClick={login} disabled={saving} style={btn()}>
          {saving ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ'}
        </button>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 620, margin: '40px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>
      <h2 style={{ color: '#1a3a5c' }}>🎌 ตั้งประกาศวันหยุด</h2>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
        บอทยังตอบคำถามลูกค้าตามปกติทุกช่องทาง (LINE/Facebook/Web Chat) — แค่แนบข้อความแจ้งวันหยุดนี้ไปด้วยครั้งแรกของแต่ละวันที่ลูกค้าทัก
      </p>

      {/* ฟอร์มเพิ่มวันหยุด */}
      <form onSubmit={addRule} style={{ background: '#f0f4f8', padding: 16, borderRadius: 8, marginBottom: 28 }}>
        <h3 style={{ margin: '0 0 14px', color: '#1a3a5c' }}>+ เพิ่มวันหยุด</h3>

        <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 4 }}>วันที่เริ่ม</label>
            <input type="date" value={startDate} onChange={e => setStart(e.target.value)} style={input} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 4 }}>วันที่สิ้นสุด</label>
            <input type="date" value={endDate} onChange={e => setEnd(e.target.value)} style={input} />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 4 }}>ชื่อวันหยุด</label>
          <input type="text" placeholder="เช่น วันหยุดสงกรานต์" value={label}
            onChange={e => setLabel(e.target.value)} style={input} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 4 }}>ข้อความแจ้งลูกค้า</label>
          <textarea placeholder='เช่น "ร้านปิดทำการวันที่ 13-15 เม.ย. เนื่องในวันหยุดสงกรานต์ กลับมาให้บริการวันที่ 16 เม.ย.ค่ะ 🙏"'
            value={message} onChange={e => setMessage(e.target.value)}
            rows={3} style={{ ...input, resize: 'vertical' }} />
        </div>

        {error && <p style={{ color: 'red', margin: '0 0 12px' }}>{error}</p>}
        <button type="submit" disabled={saving} style={btn()}>
          {saving ? 'กำลังบันทึก...' : '+ บันทึกวันหยุด'}
        </button>
      </form>

      {/* รายการวันหยุด */}
      <h3 style={{ color: '#1a3a5c', marginBottom: 10 }}>วันหยุดที่ตั้งไว้ ({rules.length})</h3>
      {rules.length === 0
        ? <p style={{ color: '#999' }}>ยังไม่มีวันหยุดที่ตั้งไว้</p>
        : rules
          .slice()
          .sort((a, b) => a.startDate.localeCompare(b.startDate))
          .map(rule => (
            <div key={rule.id} style={card(rule.enabled)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span style={{ fontWeight: 'bold', color: rule.enabled ? '#1a3a5c' : '#999' }}>
                    {rule.label}
                  </span>
                  <span style={{ margin: '0 8px', color: '#555' }}>
                    {formatDate(rule.startDate)} – {formatDate(rule.endDate)}
                  </span>
                  <span style={badge(rule.enabled)}>
                    {rule.enabled ? 'เปิดใช้งาน' : 'ปิดชั่วคราว'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={outBtn()} onClick={() => toggle(rule.id, !rule.enabled)}>
                    {rule.enabled ? 'ปิดชั่วคราว' : 'เปิดใหม่'}
                  </button>
                  <button style={outBtn('#c00')} onClick={() => remove(rule.id)}>ลบ</button>
                </div>
              </div>
              <p style={{ color: '#555', fontSize: 13, marginTop: 8, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                {rule.message}
              </p>
            </div>
          ))
      }
    </div>
  )
}
