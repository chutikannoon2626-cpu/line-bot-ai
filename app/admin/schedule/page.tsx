'use client'
import { useState, useEffect, FormEvent } from 'react'
import type { CSSProperties } from 'react'

interface Rule {
  id: string
  days: number[]
  startTime: string
  endTime: string
  enabled: boolean
}

const DAY_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const DAY_FULL  = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์']

function formatDays(days: number[]): string {
  return [...days].sort((a, b) => a - b).map(d => DAY_FULL[d]).join(', ')
}

const pill = (on: boolean): CSSProperties => ({
  display: 'inline-block', padding: '6px 14px', borderRadius: 20, cursor: 'pointer',
  background: on ? '#1a3a5c' : '#ddd', color: on ? '#fff' : '#333',
  fontWeight: 'bold', fontSize: 13, userSelect: 'none',
})
const btn = (color = '#1a3a5c'): CSSProperties => ({
  padding: '8px 20px', background: color, color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
})
const outBtn = (color = '#1a3a5c'): CSSProperties => ({
  padding: '5px 14px', background: '#fff', color,
  border: `1px solid ${color}`, borderRadius: 4, cursor: 'pointer', fontSize: 13,
})
const card = (on: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
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

function useBangkokTime() {
  const [now, setNow] = useState('')
  useEffect(() => {
    const update = () => {
      const d = new Date()
      setNow(d.toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }))
    }
    update()
    const t = setInterval(update, 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

export default function SchedulePage() {
  const [key, setKey]       = useState('')
  const [authed, setAuthed] = useState(false)
  const bangkokTime = useBangkokTime()
  const [rules, setRules]   = useState<Rule[]>([])
  const [days, setDays]     = useState<number[]>([])
  const [startTime, setStart] = useState('12:00')
  const [endTime, setEnd]     = useState('13:00')
  const [error, setError]   = useState('')
  const [saving, setSaving] = useState(false)

  const apiUrl = () => `/api/admin/schedule?key=${encodeURIComponent(key)}`

  async function login() {
    setSaving(true); setError('')
    const res = await fetch(apiUrl())
    if (res.ok) { setRules(await res.json()); setAuthed(true) }
    else setError('รหัสผ่านไม่ถูกต้อง')
    setSaving(false)
  }

  async function addRule(e: FormEvent) {
    e.preventDefault()
    if (days.length === 0) { setError('กรุณาเลือกอย่างน้อย 1 วัน'); return }
    if (startTime === endTime) { setError('เวลาเริ่มและเวลาจบต้องไม่เท่ากัน'); return }
    setSaving(true); setError('')
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, startTime, endTime }),
    })
    if (res.ok) {
      const newRule = await res.json() as Rule
      setRules(r => [...r, newRule])
      setDays([])
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
        <h2 style={{ color: '#1a3a5c' }}>🔐 น้องใจดี — Admin Schedule</h2>
        <p style={{ color: '#666', fontSize: 13 }}>ใส่รหัสผ่านผู้ดูแลระบบ</p>
        <input
          type="password" placeholder="รหัสผ่าน" value={key}
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()}
          style={{ width: '100%', padding: 10, marginBottom: 10, fontSize: 14, boxSizing: 'border-box', borderRadius: 4, border: '1px solid #ccc' }}
        />
        {error && <p style={{ color: 'red', margin: '4px 0 12px' }}>{error}</p>}
        <button onClick={login} disabled={saving} style={btn()}>
          {saving ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ'}
        </button>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>
      <h2 style={{ color: '#1a3a5c' }}>📅 ตั้งเวลาปิดบอทซ้ำทุกสัปดาห์</h2>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
        ช่วงเวลาที่กำหนด บอทจะไม่ตอบอัตโนมัติ (LINE OA และ Facebook ใช้กฎเดียวกัน)
      </p>
      <div style={{ background: '#e8f0fe', borderRadius: 8, padding: '8px 14px', marginBottom: 24, fontSize: 13, color: '#1a3a5c' }}>
        🕐 เวลาปัจจุบัน (Bangkok): <strong>{bangkokTime}</strong>
      </div>

      {/* ฟอร์มเพิ่มกฎ */}
      <form onSubmit={addRule} style={{ background: '#f0f4f8', padding: 16, borderRadius: 8, marginBottom: 28 }}>
        <h3 style={{ margin: '0 0 14px', color: '#1a3a5c' }}>เพิ่มกฎใหม่</h3>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 6 }}>วันในสัปดาห์</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {DAY_SHORT.map((name, i) => (
              <label key={i} style={pill(days.includes(i))}>
                <input type="checkbox" style={{ display: 'none' }}
                  checked={days.includes(i)}
                  onChange={e => setDays(d => e.target.checked ? [...d, i] : d.filter(x => x !== i))}
                />
                {name}
              </label>
            ))}
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button type="button" style={outBtn()} onClick={() => setDays([1,2,3,4,5])}>จ–ศ</button>
            <button type="button" style={outBtn()} onClick={() => setDays([0,6])}>เสาร์–อาทิตย์</button>
            <button type="button" style={outBtn()} onClick={() => setDays([0,1,2,3,4,5,6])}>ทุกวัน</button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 14, alignItems: 'flex-end' }}>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 4 }}>เวลาเริ่ม</label>
            <input type="time" value={startTime} onChange={e => setStart(e.target.value)}
              style={{ padding: 8, fontSize: 14, borderRadius: 4, border: '1px solid #ccc' }} />
          </div>
          <span style={{ paddingBottom: 8 }}>—</span>
          <div>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: 4 }}>เวลาจบ</label>
            <input type="time" value={endTime} onChange={e => setEnd(e.target.value)}
              style={{ padding: 8, fontSize: 14, borderRadius: 4, border: '1px solid #ccc' }} />
          </div>
        </div>

        {error && <p style={{ color: 'red', margin: '0 0 12px' }}>{error}</p>}
        <button type="submit" disabled={saving} style={btn()}>
          {saving ? 'กำลังบันทึก...' : '+ บันทึกกฎ'}
        </button>
      </form>

      {/* รายการกฎ */}
      <h3 style={{ color: '#1a3a5c', marginBottom: 10 }}>กฎที่ตั้งไว้ ({rules.length})</h3>
      {rules.length === 0
        ? <p style={{ color: '#999' }}>ยังไม่มีกฎ — บอทตอบตลอดเวลา</p>
        : rules.map(rule => (
          <div key={rule.id} style={card(rule.enabled)}>
            <div>
              <span style={{ fontWeight: 'bold', color: rule.enabled ? '#1a3a5c' : '#999' }}>
                {formatDays(rule.days)}
              </span>
              <span style={{ margin: '0 8px', color: '#555' }}>
                {rule.startTime} – {rule.endTime}
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
        ))
      }
    </div>
  )
}
