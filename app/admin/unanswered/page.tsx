'use client'
import { useState } from 'react'
import type { CSSProperties } from 'react'

type Tab        = 'unanswered' | 'frequent' | 'chat'
type ChanFilter = 'all' | 'LINE' | 'Facebook' | 'Web'
type UnansweredEntry = { ts: string; userId: string; question: string }
type FreqEntry  = { member: string; score: number }
type ConvEntry  = { userId: string; channel: string; lastMessage: string; lastTs: number; count: number }
type ChatMsg    = { userId: string; channel: string; role: 'user' | 'bot'; message: string; ts: number }

function formatThai(ts: string | number): string {
  return new Date(typeof ts === 'number' ? ts : ts).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit',
  })
}
function platform(userId: string): 'Facebook' | 'Web' | 'LINE OA' {
  if (userId.startsWith('fb:'))  return 'Facebook'
  if (userId.startsWith('web:')) return 'Web'
  return 'LINE OA'
}
function shortId(userId: string): string {
  const id = userId.replace(/^(fb:|web:)/, '')
  return id.length > 12 ? '...' + id.slice(-10) : id
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
const badge = (ch: string): CSSProperties => ({
  fontSize: 11, padding: '2px 7px', borderRadius: 8, fontWeight: 'bold',
  background: ch === 'Facebook' ? '#e3f2fd' : ch === 'Web' ? '#fff3e0' : '#e8f5e9',
  color:      ch === 'Facebook' ? '#1565c0' : ch === 'Web' ? '#e65100' : '#2e7d32',
})

function exportCSV(filename: string, headers: string[], rows: string[][]): void {
  const lines = [headers, ...rows].map(r =>
    r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')
  ).join('\n')
  const blob = new Blob(['﻿' + lines], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

export default function AdminPage() {
  const [key, setKey]       = useState('')
  const [authed, setAuthed] = useState(false)
  const [tab, setTab]       = useState<Tab>('unanswered')
  const [loading, setLoading]   = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError]       = useState('')

  // tabs 1-2
  const [unanswered, setUnanswered] = useState<UnansweredEntry[]>([])
  const [frequent, setFrequent]     = useState<FreqEntry[]>([])

  // tab 3 — chat history
  const [chatConvs, setChatConvs]     = useState<ConvEntry[]>([])
  const [chatFilter, setChatFilter]   = useState<ChanFilter>('all')
  const [expandedId, setExpandedId]   = useState<string | null>(null)
  const [convMsgs, setConvMsgs]       = useState<Record<string, ChatMsg[]>>({})
  const [convLoading, setConvLoading] = useState<string | null>(null)
  const [chatLoading, setChatLoading] = useState(false)

  const apiUrl    = () => `/api/admin/unanswered?key=${encodeURIComponent(key)}`
  const todayBKK  = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)

  // ── Auth & refresh ──
  async function login() {
    setLoading(true); setError('')
    const res = await fetch(apiUrl())
    if (res.ok) {
      const d = await res.json() as { unanswered: UnansweredEntry[]; frequent: FreqEntry[] }
      setUnanswered(d.unanswered); setFrequent(d.frequent); setAuthed(true)
    } else { setError('รหัสผ่านไม่ถูกต้อง') }
    setLoading(false)
  }

  async function refresh() {
    setLoading(true)
    if (tab === 'chat') { await loadChatHistory() }
    else {
      const res = await fetch(apiUrl())
      if (res.ok) {
        const d = await res.json() as { unanswered: UnansweredEntry[]; frequent: FreqEntry[] }
        setUnanswered(d.unanswered); setFrequent(d.frequent)
      }
    }
    setLoading(false)
  }

  async function clearList(target: 'unanswered' | 'freq') {
    if (!confirm(target === 'unanswered' ? 'ล้างรายการตอบไม่ได้ทั้งหมด?' : 'ล้างสถิติถามบ่อยทั้งหมด?')) return
    setClearing(true)
    await fetch(apiUrl(), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) })
    if (target === 'unanswered') setUnanswered([]); else setFrequent([])
    setClearing(false)
  }

  // ── Chat history ──
  async function loadChatHistory() {
    setChatLoading(true)
    const res = await fetch(`/api/admin/chatlog?key=${encodeURIComponent(key)}`)
    if (res.ok) {
      const d = await res.json() as { conversations: ConvEntry[] }
      setChatConvs(d.conversations)
    }
    setChatLoading(false)
  }

  async function switchToChat() {
    setTab('chat')
    if (!chatConvs.length) await loadChatHistory()
  }

  async function toggleConv(userId: string) {
    if (expandedId === userId) { setExpandedId(null); return }
    if (convMsgs[userId])      { setExpandedId(userId); return }
    setConvLoading(userId)
    const res = await fetch(`/api/admin/chatlog?key=${encodeURIComponent(key)}&userId=${encodeURIComponent(userId)}`)
    if (res.ok) {
      const d = await res.json() as { messages: ChatMsg[] }
      setConvMsgs(prev => ({ ...prev, [userId]: d.messages }))
    }
    setExpandedId(userId); setConvLoading(null)
  }

  function openXlsx(params: string) {
    window.open(`/api/admin/chatlog/export?key=${encodeURIComponent(key)}&${params}`)
  }

  const filteredConvs = chatConvs.filter(c => chatFilter === 'all' || c.channel === chatFilter)

  // ── Login screen ──
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
    <div style={{ maxWidth: 760, margin: '40px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ color: '#1a3a5c', margin: 0 }}>📋 รายงานคำถาม</h2>
        <button onClick={refresh} disabled={loading || chatLoading} style={btn()}>
          {loading || chatLoading ? 'กำลังโหลด...' : '🔄 รีเฟรช'}
        </button>
      </div>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>LINE OA และ Facebook รวมกัน · แสดง 100 รายการล่าสุด</p>

      {/* Tab bar */}
      <div style={{ borderBottom: '1px solid #ddd', marginBottom: 20, display: 'flex' }}>
        <button style={tabStyle(tab === 'unanswered')} onClick={() => setTab('unanswered')}>
          ❓ ตอบไม่ได้ ({unanswered.length})
        </button>
        <button style={tabStyle(tab === 'frequent')} onClick={() => setTab('frequent')}>
          🔥 ถามบ่อย ({frequent.length})
        </button>
        <button style={tabStyle(tab === 'chat')} onClick={switchToChat}>
          💬 ประวัติแชท ({chatConvs.length})
        </button>
      </div>

      {/* ── Tab 1: ตอบไม่ได้ ── */}
      {tab === 'unanswered' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
            <button
              onClick={() => exportCSV(`unanswered_${new Date().toISOString().slice(0,10)}.csv`, ['เวลา','ช่องทาง','คำถาม'], unanswered.map(r => [formatThai(r.ts), platform(r.userId), r.question]))}
              disabled={unanswered.length === 0} style={outBtn('#1a3a5c')}
            >⬇ Export CSV</button>
            <button onClick={() => clearList('unanswered')} disabled={clearing || unanswered.length === 0} style={outBtn()}>ล้างทั้งหมด</button>
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

      {/* ── Tab 2: ถามบ่อย ── */}
      {tab === 'frequent' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#666' }}>นับจากคำถามที่บอทตอบได้สำเร็จ</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => exportCSV(`frequent_${new Date().toISOString().slice(0,10)}.csv`, ['อันดับ','คำถาม','จำนวนครั้ง'], frequent.map((r, i) => [String(i+1), r.member, String(r.score)]))}
                disabled={frequent.length === 0} style={outBtn('#1a3a5c')}
              >⬇ Export CSV</button>
              <button onClick={() => clearList('freq')} disabled={clearing || frequent.length === 0} style={outBtn()}>ล้างสถิติ</button>
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

      {/* ── Tab 3: ประวัติแชท ── */}
      {tab === 'chat' && (
        <>
          {/* Toolbar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['all','LINE','Facebook','Web'] as const).map(f => (
                <button key={f} onClick={() => setChatFilter(f)} style={{
                  padding: '4px 12px', fontSize: 12, borderRadius: 20, cursor: 'pointer',
                  border: chatFilter === f ? '1.5px solid #1a3a5c' : '1px solid #ccc',
                  background: chatFilter === f ? '#1a3a5c' : '#fff',
                  color: chatFilter === f ? '#fff' : '#555',
                  fontWeight: chatFilter === f ? 'bold' : 'normal',
                }}>
                  {f === 'all' ? 'ทั้งหมด' : f === 'LINE' ? 'LINE OA' : f}
                </button>
              ))}
            </div>
            <button onClick={() => openXlsx(`date=${todayBKK}`)} disabled={chatConvs.length === 0} style={outBtn('#1a3a5c')}>
              ⬇ Export วันนี้ (.xlsx)
            </button>
          </div>

          {/* States */}
          {chatLoading && <p style={{ color: '#999', textAlign: 'center', padding: 40 }}>กำลังโหลด...</p>}
          {!chatLoading && filteredConvs.length === 0 && (
            <p style={{ color: '#999', textAlign: 'center', padding: 40 }}>ยังไม่มีประวัติแชท</p>
          )}

          {/* Conversation rows */}
          {!chatLoading && filteredConvs.map(conv => {
            const isExp  = expandedId === conv.userId
            const isLoad = convLoading === conv.userId
            const msgs   = convMsgs[conv.userId] ?? []
            return (
              <div key={conv.userId} style={{ marginBottom: 6, border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>

                {/* Row header */}
                <div
                  onClick={() => toggleConv(conv.userId)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: isExp ? '#f0f4f8' : '#fff' }}
                >
                  <span style={badge(conv.channel)}>{conv.channel === 'LINE' ? 'LINE OA' : conv.channel}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#888', flexShrink: 0 }}>{shortId(conv.userId)}</span>
                  <span style={{ flex: 1, fontSize: 13, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {conv.lastMessage}
                  </span>
                  <span style={{ fontSize: 11, color: '#bbb', whiteSpace: 'nowrap' }}>{formatTime(conv.lastTs)}</span>
                  <span style={{ background: '#e8f0fe', color: '#1a3a5c', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                    {conv.count} ข้อ
                  </span>
                  <span style={{ color: '#bbb', fontSize: 11 }}>{isExp ? '▲' : '▼'}</span>
                </div>

                {/* Expanded thread */}
                {isExp && (
                  <div style={{ borderTop: '1px solid #e8e8e8', background: '#fafafa' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px', borderBottom: '1px solid #eee' }}>
                      <button onClick={() => openXlsx(`userId=${encodeURIComponent(conv.userId)}`)} style={outBtn('#1a3a5c')}>
                        ⬇ Export บทสนทนานี้ (.xlsx)
                      </button>
                    </div>
                    <div style={{ padding: '12px 16px', maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {isLoad && <p style={{ color: '#aaa', textAlign: 'center' }}>กำลังโหลด...</p>}
                      {!isLoad && msgs.length === 0 && <p style={{ color: '#aaa', textAlign: 'center' }}>ไม่มีข้อมูล</p>}
                      {msgs.map((m, mi) => {
                        const isBot = m.role === 'bot'
                        return (
                          <div key={mi} style={{ display: 'flex', flexDirection: 'column', alignItems: isBot ? 'flex-start' : 'flex-end' }}>
                            <div style={{ fontSize: 10, color: '#bbb', marginBottom: 2 }}>
                              {formatTime(m.ts)} · {isBot ? 'น้องใจดี' : 'ลูกค้า'}
                            </div>
                            <div style={{
                              maxWidth: '78%', padding: '8px 12px', fontSize: 13, lineHeight: 1.55,
                              borderRadius: isBot ? '4px 14px 14px 14px' : '14px 14px 4px 14px',
                              background: isBot ? '#fff' : '#1a3a5c', color: isBot ? '#222' : '#fff',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                              boxShadow: '0 1px 3px rgba(0,0,0,.08)',
                            }}>
                              {m.message}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
