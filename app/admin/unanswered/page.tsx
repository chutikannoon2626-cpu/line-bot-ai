'use client'
import { useState } from 'react'
import type { CSSProperties } from 'react'

type Tab = 'unanswered' | 'frequent'
type UnansweredEntry = { ts: string; userId: string; question: string }
type FreqEntry = { member: string; score: number }

function formatThai(ts: string): string {
  return new Date(ts).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function platform(userId: string): 'Facebook' | 'Web' | 'LINE OA' {
  if (userId.startsWith('fb:'))  return 'Facebook'
  if (userId.startsWith('web:')) return 'Web'
  return 'LINE OA'
}

const btn = (color = '#1a3a5c'): CSSProperties => ({
  padding: '8px 20px', background: color, color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
})
const outBtn = (color = '#c00'): CSSProperties => ({
  padding: '5px 14px', background: '#fff', color,
  border: `1px solid ${color}`, borderRadius: 4, cursor: 'pointer', fontSize: 13,
})

function exportCSV(filename: string, headers: string[], rows: string[][]): void {
  const lines = [headers, ...rows].map(r =>
    r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')
  ).join('\n')
  const blob = new Blob(['﻿' + lines], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
const tabStyle = (active: boolean): CSSProperties => ({
  padding: '8px 24px', cursor: 'pointer', fontWeight: active ? 'bold' : 'normal',
  borderTop: 'none', borderLeft: 'none', borderRight: 'none',
  borderBottom: active ? '3px solid #1a3a5c' : '3px solid transparent',
  color: active ? '#1a3a5c' : '#666', background: 'none',
  fontSize: 15,
})
const badge = (text: string): CSSProperties => ({
  fontSize: 11, padding: '2px 7px', borderRadius: 8,
  background: text === 'Facebook' ? '#e3f2fd' : text === 'Web' ? '#fff3e0' : '#e8f5e9',
  color: text === 'Facebook' ? '#1565c0' : text === 'Web' ? '#e65100' : '#2e7d32',
  fontWeight: 'bold',
})

export default function UnansweredPage() {
  const [key, setKey]         = useState('')
  const [authed, setAuthed]   = useState(false)
  const [tab, setTab]         = useState<Tab>('unanswered')
  const [unanswered, setUnanswered] = useState<UnansweredEntry[]>([])
  const [frequent, setFrequent]     = useState<FreqEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError]     = useState('')

  const apiUrl = () => `/api/admin/unanswered?key=${encodeURIComponent(key)}`

  async function login() {
    setLoading(true); setError('')
    const res = await fetch(apiUrl())
    if (res.ok) {
      const data = await res.json() as { unanswered: UnansweredEntry[]; frequent: FreqEntry[] }
      setUnanswered(data.unanswered)
      setFrequent(data.frequent)
      setAuthed(true)
    } else {
      setError('รหัสผ่านไม่ถูกต้อง')
    }
    setLoading(false)
  }

  async function refresh() {
    setLoading(true)
    const res = await fetch(apiUrl())
    if (res.ok) {
      const data = await res.json() as { unanswered: UnansweredEntry[]; frequent: FreqEntry[] }
      setUnanswered(data.unanswered)
      setFrequent(data.frequent)
    }
    setLoading(false)
  }

  async function clearList(target: 'unanswered' | 'freq') {
    if (!confirm(target === 'unanswered' ? 'ล้างรายการตอบไม่ได้ทั้งหมด?' : 'ล้างสถิติถามบ่อยทั้งหมด?')) return
    setClearing(true)
    await fetch(apiUrl(), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    })
    if (target === 'unanswered') setUnanswered([])
    else setFrequent([])
    setClearing(false)
  }

  if (!authed) {
    return (
      <div style={{ maxWidth: 400, margin: '100px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>
        <h2 style={{ color: '#1a3a5c' }}>🔐 น้องใจดี — Admin</h2>
        <p style={{ color: '#666', fontSize: 13 }}>ใส่รหัสผ่านผู้ดูแลระบบ</p>
        <input
          type="password" placeholder="รหัสผ่าน" value={key}
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()}
          style={{ width: '100%', padding: 10, marginBottom: 10, fontSize: 14, boxSizing: 'border-box', borderRadius: 4, border: '1px solid #ccc' }}
        />
        {error && <p style={{ color: 'red', margin: '4px 0 12px' }}>{error}</p>}
        <button onClick={login} disabled={loading} style={btn()}>
          {loading ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ'}
        </button>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 700, margin: '40px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ color: '#1a3a5c', margin: 0 }}>📋 รายงานคำถาม</h2>
        <button onClick={refresh} disabled={loading} style={btn()}>
          {loading ? 'กำลังโหลด...' : '🔄 รีเฟรช'}
        </button>
      </div>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
        LINE OA และ Facebook รวมกัน · แสดง 100 รายการล่าสุด
      </p>

      {/* Tabs */}
      <div style={{ borderBottom: '1px solid #ddd', marginBottom: 20, display: 'flex' }}>
        <button style={tabStyle(tab === 'unanswered')} onClick={() => setTab('unanswered')}>
          ❓ ตอบไม่ได้ ({unanswered.length})
        </button>
        <button style={tabStyle(tab === 'frequent')} onClick={() => setTab('frequent')}>
          🔥 ถามบ่อย ({frequent.length})
        </button>
      </div>

      {/* Tab: ตอบไม่ได้ */}
      {tab === 'unanswered' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
            <button
              onClick={() => exportCSV(
                `unanswered_${new Date().toISOString().slice(0,10)}.csv`,
                ['เวลา', 'ช่องทาง', 'คำถาม'],
                unanswered.map(r => [formatThai(r.ts), platform(r.userId), r.question]),
              )}
              disabled={unanswered.length === 0}
              style={outBtn('#1a3a5c')}
            >
              ⬇ Export CSV
            </button>
            <button onClick={() => clearList('unanswered')} disabled={clearing || unanswered.length === 0} style={outBtn()}>
              ล้างทั้งหมด
            </button>
          </div>
          {unanswered.length === 0
            ? <p style={{ color: '#999', textAlign: 'center', padding: 40 }}>ไม่มีคำถามที่ตอบไม่ได้ 🎉</p>
            : unanswered.map((item, i) => (
              <div key={i} style={{ background: '#fff', border: '1px solid #eee', borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={badge(platform(item.userId))}>{platform(item.userId)}</span>
                  <span style={{ fontSize: 12, color: '#999' }}>{formatThai(item.ts)}</span>
                </div>
                <p style={{ margin: 0, fontSize: 14, color: '#222' }}>{item.question}</p>
              </div>
            ))
          }
        </>
      )}

      {/* Tab: ถามบ่อย */}
      {tab === 'frequent' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#666' }}>นับจากคำถามที่บอทตอบได้สำเร็จ</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => exportCSV(
                  `frequent_${new Date().toISOString().slice(0,10)}.csv`,
                  ['อันดับ', 'คำถาม', 'จำนวนครั้ง'],
                  frequent.map((r, i) => [String(i + 1), r.member, String(r.score)]),
                )}
                disabled={frequent.length === 0}
                style={outBtn('#1a3a5c')}
              >
                ⬇ Export CSV
              </button>
              <button onClick={() => clearList('freq')} disabled={clearing || frequent.length === 0} style={outBtn()}>
                ล้างสถิติ
              </button>
            </div>
          </div>
          {frequent.length === 0
            ? <p style={{ color: '#999', textAlign: 'center', padding: 40 }}>ยังไม่มีสถิติ</p>
            : frequent.map((item, i) => (
              <div key={i} style={{ background: '#fff', border: '1px solid #eee', borderRadius: 8, padding: '12px 16px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ minWidth: 28, height: 28, background: i < 3 ? '#1a3a5c' : '#eee', color: i < 3 ? '#fff' : '#555', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: 13 }}>
                  {i + 1}
                </span>
                <p style={{ margin: 0, fontSize: 14, color: '#222', flex: 1 }}>{item.member}</p>
                <span style={{ background: '#e8f0fe', color: '#1a3a5c', padding: '3px 10px', borderRadius: 12, fontWeight: 'bold', fontSize: 13 }}>
                  {item.score} ครั้ง
                </span>
              </div>
            ))
          }
        </>
      )}
    </div>
  )
}
