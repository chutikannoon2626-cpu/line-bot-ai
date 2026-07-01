'use client'
import { Fragment, useState } from 'react'
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
  const cfg: Record<string, { bg: string; color: string; label: string }> = {
    LINE:     { bg: '#06c755', color: '#fff', label: 'LINE' },
    Facebook: { bg: '#1877f2', color: '#fff', label: 'FB' },
    Web:      { bg: '#f59e0b', color: '#fff', label: 'Web' },
    'LINE OA':{ bg: '#06c755', color: '#fff', label: 'LINE' },
  }
  const s = cfg[ch] ?? { bg: '#888', color: '#fff', label: ch }
  return (
    <span style={{ display: 'inline-block', background: s.bg, color: s.color, fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 4, letterSpacing: 0.3 }}>
      {s.label}
    </span>
  )
}

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
const TD = ({ children, center, mono, muted }: { children: React.ReactNode; center?: boolean; mono?: boolean; muted?: boolean }) => (
  <td style={{
    padding: '10px 14px', textAlign: center ? 'center' : 'left',
    fontFamily: mono ? 'monospace' : undefined,
    color: muted ? '#aaa' : undefined, fontSize: 13, verticalAlign: 'middle',
  }}>
    {children}
  </td>
)

export default function AdminPage() {
  const [key, setKey]       = useState('')
  const [authed, setAuthed] = useState(false)
  const [tab, setTab]       = useState<Tab>('unanswered')
  const [loading, setLoading]   = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError]       = useState('')

  const [unanswered, setUnanswered] = useState<UnansweredEntry[]>([])
  const [frequent, setFrequent]     = useState<FreqEntry[]>([])

  const [chatConvs, setChatConvs]     = useState<ConvEntry[]>([])
  const [chatFilter, setChatFilter]   = useState<ChanFilter>('all')
  const [expandedId, setExpandedId]   = useState<string | null>(null)
  const [convMsgs, setConvMsgs]       = useState<Record<string, ChatMsg[]>>({})
  const [convLoading, setConvLoading] = useState<string | null>(null)
  const [chatLoading, setChatLoading] = useState(false)

  const apiUrl   = () => `/api/admin/unanswered?key=${encodeURIComponent(key)}`
  const todayBKK = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)

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
    <div style={{ maxWidth: 820, margin: '40px auto', fontFamily: 'Sarabun, sans-serif', padding: 24 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ color: '#1a3a5c', margin: 0 }}>📋 รายงานคำถาม</h2>
        <button onClick={refresh} disabled={loading || chatLoading} style={btn()}>
          {loading || chatLoading ? 'กำลังโหลด...' : '🔄 รีเฟรช'}
        </button>
      </div>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>LINE OA · Facebook · Web — แสดง 100 รายการล่าสุด</p>

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
                  <ChBadge ch={platform(item.userId)} />
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: '#222' }}>
              บทสนทนาวันนี้
              <span style={{ fontSize: 13, fontWeight: 'normal', color: '#888', marginLeft: 6 }}>
                ({filteredConvs.length} รายการ)
              </span>
            </span>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <select
                value={chatFilter}
                onChange={e => setChatFilter(e.target.value as ChanFilter)}
                style={{ padding: '6px 28px 6px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13, cursor: 'pointer', background: '#fff', color: '#333', appearance: 'auto' }}
              >
                <option value="all">ทุกช่องทาง</option>
                <option value="LINE">LINE OA</option>
                <option value="Facebook">Facebook</option>
                <option value="Web">Web</option>
              </select>
              <button
                onClick={() => openXlsx(`date=${todayBKK}`)}
                disabled={chatConvs.length === 0}
                style={{ ...btn('#1a7c4e'), display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px' }}
              >
                ⬇ ดาวน์โหลด Excel
              </button>
            </div>
          </div>

          {/* Loading / empty */}
          {chatLoading && (
            <p style={{ color: '#999', textAlign: 'center', padding: 60 }}>กำลังโหลด...</p>
          )}
          {!chatLoading && filteredConvs.length === 0 && (
            <p style={{ color: '#999', textAlign: 'center', padding: 60 }}>ยังไม่มีประวัติแชท</p>
          )}

          {/* Table */}
          {!chatLoading && filteredConvs.length > 0 && (
            <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: 90 }} />
                  <col />
                  <col style={{ width: 72 }} />
                  <col style={{ width: 68 }} />
                  <col style={{ width: 68 }} />
                </colgroup>
                <thead>
                  <tr>
                    <TH>ช่องทาง</TH>
                    <TH>ข้อความล่าสุด</TH>
                    <TH center>จำนวน</TH>
                    <TH center>เวลา</TH>
                    <TH center>ดาวน์โหลด</TH>
                  </tr>
                </thead>
                <tbody>
                  {filteredConvs.map(conv => {
                    const isExp  = expandedId === conv.userId
                    const isLoad = convLoading === conv.userId
                    const msgs   = convMsgs[conv.userId] ?? []
                    return (
                      <Fragment key={conv.userId}>
                        {/* Data row */}
                        <tr
                          onClick={() => toggleConv(conv.userId)}
                          style={{
                            cursor: 'pointer',
                            background: isExp ? '#f0f4f8' : '#fff',
                            borderTop: '1px solid #eee',
                            transition: 'background .1s',
                          }}
                        >
                          <TD>
                            <ChBadge ch={conv.channel} />
                          </TD>
                          <td style={{ padding: '10px 14px', fontSize: 13, verticalAlign: 'middle', overflow: 'hidden' }}>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#333' }}>
                              {conv.lastMessage || <span style={{ color: '#ccc', fontStyle: 'italic' }}>ไม่มีข้อความ</span>}
                            </div>
                          </td>
                          <TD center>
                            <span style={{ color: '#1a3a5c', fontWeight: 'bold' }}>{conv.count}</span>
                            <span style={{ color: '#aaa', fontSize: 11, marginLeft: 2 }}>ข้อ</span>
                          </TD>
                          <TD center muted>{formatTime(conv.lastTs)}</TD>
                          <td style={{ padding: '10px 14px', textAlign: 'center', verticalAlign: 'middle' }}
                              onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => openXlsx(`userId=${encodeURIComponent(conv.userId)}`)}
                              title="ดาวน์โหลด Excel บทสนทนานี้"
                              style={{
                                background: '#f5f7fa', border: '1px solid #ddd', borderRadius: 6,
                                width: 32, height: 32, cursor: 'pointer', fontSize: 14,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                color: '#555',
                              }}
                            >
                              ⬇
                            </button>
                          </td>
                        </tr>

                        {/* Expanded thread row */}
                        {isExp && (
                          <tr style={{ background: '#fafafa' }}>
                            <td colSpan={5} style={{ padding: 0, borderTop: '1px solid #e0e0e0', borderBottom: '1px solid #e0e0e0' }}>
                              <div style={{ padding: '14px 18px', maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {isLoad && <p style={{ color: '#aaa', textAlign: 'center', margin: 0 }}>กำลังโหลด...</p>}
                                {!isLoad && msgs.length === 0 && <p style={{ color: '#aaa', textAlign: 'center', margin: 0 }}>ไม่มีข้อมูล</p>}
                                {msgs.map((m, mi) => {
                                  const isBot = m.role === 'bot'
                                  return (
                                    <div key={mi} style={{ display: 'flex', flexDirection: 'column', alignItems: isBot ? 'flex-start' : 'flex-end' }}>
                                      <div style={{ fontSize: 10, color: '#bbb', marginBottom: 3 }}>
                                        {formatTime(m.ts)} · {isBot ? 'น้องใจดี' : 'ลูกค้า'}
                                      </div>
                                      <div style={{
                                        maxWidth: '76%', padding: '8px 12px', fontSize: 13, lineHeight: 1.6,
                                        borderRadius: isBot ? '4px 14px 14px 14px' : '14px 14px 4px 14px',
                                        background: isBot ? '#fff' : '#1a3a5c',
                                        color: isBot ? '#222' : '#fff',
                                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                        boxShadow: '0 1px 3px rgba(0,0,0,.08)',
                                      }}>
                                        {m.message}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
