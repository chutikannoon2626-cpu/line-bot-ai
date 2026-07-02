(function () {
  'use strict';

  var API_URL      = 'https://line-bot-ai-theta.vercel.app/api/web-chat';
  var TOOLTIP_DELAY = 7000; // 7 วินาที

  // Session ID — อยู่แค่ในแท็บนี้ ปิดแล้วหาย
  var sessionId = sessionStorage.getItem('nj_sid');
  if (!sessionId) {
    sessionId = 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('nj_sid', sessionId);
  }

  var isOpen = false;
  var tooltipDismissed = false;

  // ── Inject styles ──
  var style = document.createElement('style');
  style.textContent = [
    '#nj-widget *{box-sizing:border-box;font-family:"Sarabun",Tahoma,sans-serif}',
    '#nj-btn{position:fixed;bottom:24px;right:24px;z-index:2147483640;',
      'width:50px;height:50px;padding:0;border-radius:50%;background:#064fa3;color:#fff;',
      'border:none;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);',
      'display:flex;align-items:center;justify-content:center;',
      'transition:transform .15s,box-shadow .15s;user-select:none}',
    '#nj-btn:hover{transform:scale(1.03);box-shadow:0 6px 22px rgba(0,0,0,.3)}',

    '#nj-tooltip{position:fixed;bottom:88px;right:24px;z-index:2147483639;',
      'background:#fff;border-radius:10px;padding:10px 14px 10px 12px;',
      'box-shadow:0 4px 18px rgba(0,0,0,.15);font-size:14px;color:#222;',
      'max-width:220px;line-height:1.5;cursor:pointer;',
      'display:none;animation:njFadeIn .35s ease}',
    '#nj-tooltip::after{content:"";position:absolute;bottom:-8px;right:18px;',
      'border:8px solid transparent;border-top-color:#fff;border-bottom:0}',
    '#nj-ttclose{float:right;margin-left:6px;cursor:pointer;color:#aaa;',
      'font-size:17px;line-height:1;font-weight:bold}',
    '#nj-ttclose:hover{color:#555}',

    '#nj-panel{position:fixed;bottom:88px;right:24px;z-index:2147483638;',
      'width:360px;height:510px;border-radius:14px;background:#fff;',
      'box-shadow:0 8px 36px rgba(0,0,0,.18);',
      'display:none;flex-direction:column;overflow:hidden}',
    '#nj-panel.nj-open{display:flex;animation:njSlideUp .22s ease}',

    '#nj-head{background:#1a3a5c;color:#fff;padding:13px 14px;',
      'display:flex;align-items:center;gap:10px;flex-shrink:0}',
    '#nj-avatar{width:38px;height:38px;border-radius:50%;background:#2d5a8c;',
      'display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}',
    '#nj-hinfo{flex:1;min-width:0}',
    '#nj-hname{font-weight:bold;font-size:15px}',
    '#nj-hsub{font-size:11px;color:#9bc;margin-top:1px}',
    '#nj-xbtn{background:none;border:none;color:#fff;cursor:pointer;',
      'font-size:24px;padding:0 2px;line-height:1;opacity:.8}',
    '#nj-xbtn:hover{opacity:1}',

    '#nj-msgs{flex:1;overflow-y:auto;padding:12px 10px;',
      'display:flex;flex-direction:column;gap:8px;background:#f5f7fb}',

    '.nj-row{display:flex;max-width:88%}',
    '.nj-row.nj-bot{align-self:flex-start}',
    '.nj-row.nj-user{align-self:flex-end}',
    '.nj-bbl{padding:9px 13px;border-radius:14px;font-size:14px;',
      'line-height:1.55;word-break:break-word;white-space:pre-wrap}',
    '.nj-bot .nj-bbl{background:#fff;color:#222;',
      'border-radius:4px 14px 14px 14px;box-shadow:0 1px 3px rgba(0,0,0,.09)}',
    '.nj-user .nj-bbl{background:#1a3a5c;color:#fff;',
      'border-radius:14px 14px 4px 14px}',
    '.nj-bbl a{color:#5b9bd5;word-break:break-all}',
    '.nj-user .nj-bbl a{color:#9bc}',
    '#nj-typing{color:#bbb;font-size:24px;letter-spacing:3px;padding:4px 10px}',

    '#nj-foot{padding:9px 10px;border-top:1px solid #eee;',
      'display:flex;gap:8px;align-items:center;background:#fff;flex-shrink:0}',
    '#nj-inp{flex:1;padding:9px 13px;border:1px solid #ddd;border-radius:20px;',
      'font-size:14px;outline:none;font-family:"Sarabun",Tahoma,sans-serif;',
      'background:#f8f9fb;transition:border-color .15s}',
    '#nj-inp:focus{border-color:#1a3a5c;background:#fff}',
    '#nj-inp:disabled{background:#f0f0f0;color:#aaa}',
    '#nj-send{width:40px;height:40px;border-radius:50%;background:#064fa3;',
      'border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'flex-shrink:0;transition:background .15s;font-size:18px;color:#fff;line-height:1}',
    '#nj-send:hover{background:#053d80}',
    '#nj-send:disabled{background:#ccc;cursor:default}',

    '@keyframes njFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '@keyframes njSlideUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',

    '@media(max-width:480px){',
      '#nj-panel{width:calc(100vw - 16px);right:8px;bottom:80px;height:72vh}',
      '#nj-btn{bottom:16px;right:12px;width:44px;height:44px;padding:0}',
      '#nj-tooltip{right:8px}',
    '}',
  ].join('');
  document.head.appendChild(style);

  // ── Build DOM ──
  var root = document.createElement('div');
  root.id = 'nj-widget';
  root.innerHTML =
    '<div id="nj-tooltip">' +
      '<span id="nj-ttclose">×</span>' +
      'มีคำถามไหมคะ?&nbsp;แชทกับ<strong>น้องใจดี</strong>ได้เลย&nbsp;😊' +
    '</div>' +
    '<div id="nj-panel">' +
      '<div id="nj-head">' +
        '<div id="nj-avatar">🤖</div>' +
        '<div id="nj-hinfo">' +
          '<div id="nj-hname">น้องใจดี</div>' +
          '<div id="nj-hsub">Spender Club · วิทยุสื่อสาร</div>' +
        '</div>' +
        '<button id="nj-xbtn" title="ปิด">×</button>' +
      '</div>' +
      '<input id="nj-hp" type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;opacity:0;height:0;width:0;pointer-events:none"/>' +
      '<div id="nj-msgs"></div>' +
      '<div id="nj-foot">' +
        '<input id="nj-inp" type="text" placeholder="พิมพ์ข้อความ..." maxlength="500" autocomplete="off"/>' +
        '<button id="nj-send" title="ส่ง">➤</button>' +
      '</div>' +
    '</div>' +
    '<button id="nj-btn" title="แชทกับน้องใจดี">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
      '</svg>' +
    '</button>';

  document.body.appendChild(root);

  var btn      = document.getElementById('nj-btn');
  var panel    = document.getElementById('nj-panel');
  var xbtn     = document.getElementById('nj-xbtn');
  var msgs     = document.getElementById('nj-msgs');
  var inp      = document.getElementById('nj-inp');
  var sendBtn  = document.getElementById('nj-send');
  var tooltip  = document.getElementById('nj-tooltip');
  var ttclose  = document.getElementById('nj-ttclose');

  // ── Helpers ──
  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function linkify(s) {
    return escHtml(s).replace(
      /(https?:\/\/[^\s<>"]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
  }

  function addMsg(text, from) {
    if (!text) return;
    var row = document.createElement('div');
    row.className = 'nj-row nj-' + from;
    var bbl = document.createElement('div');
    bbl.className = 'nj-bbl';
    bbl.innerHTML = linkify(text);
    row.appendChild(bbl);
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function showTyping() {
    var row = document.createElement('div');
    row.className = 'nj-row nj-bot';
    row.id = 'nj-typing';
    row.innerHTML = '<div class="nj-bbl" style="color:#bbb;font-size:22px;letter-spacing:3px">•••</div>';
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function removeTyping() {
    var t = document.getElementById('nj-typing');
    if (t) t.remove();
  }

  function setLoading(on) {
    inp.disabled  = on;
    sendBtn.disabled = on;
  }

  // ── Send ──
  function send() {
    var text = inp.value.trim();
    if (!text || inp.disabled) return;
    inp.value = '';
    addMsg(text, 'user');
    setLoading(true);
    showTyping();

    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, message: text, _hp: (document.getElementById('nj-hp') || {value:''}).value }),
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      removeTyping();
      if (d.reply) addMsg(d.reply, 'bot');
    })
    .catch(function() {
      removeTyping();
      addMsg('เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งนะคะ 🙏', 'bot');
    })
    .finally(function() {
      setLoading(false);
      inp.focus();
    });
  }

  // ── Open / Close ──
  function openPanel() {
    isOpen = true;
    panel.classList.add('nj-open');
    btn.style.display = 'none';
    hideTooltip();
    if (!msgs.children.length) {
      addMsg('สวัสดีค่ะ ยินดีต้อนรับสู่ Spender Club 😊\nมีคำถามเรื่องวิทยุสื่อสารหรืออุปกรณ์สื่อสารอะไรไหมคะ พิมพ์ถามได้เลยนะคะ', 'bot');
    }
    setTimeout(function() { inp.focus(); }, 50);
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('nj-open');
    btn.style.display = 'flex';
    panel.style.bottom = '';
    // ล้าง history ทันที — เปิดใหม่เริ่มใหม่เสมอ
    msgs.innerHTML = '';
    sessionStorage.removeItem('nj_sid');
    sessionId = 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('nj_sid', sessionId);
  }

  // ── Tooltip ──
  function showTooltip() {
    if (tooltipDismissed || isOpen) return;
    tooltip.style.display = 'block';
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
    tooltipDismissed = true;
  }

  // ── Events ──
  btn.addEventListener('click', function() { isOpen ? closePanel() : openPanel(); });
  xbtn.addEventListener('click', closePanel);
  sendBtn.addEventListener('click', send);
  ttclose.addEventListener('click', function(e) { e.stopPropagation(); hideTooltip(); });
  tooltip.addEventListener('click', openPanel);
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ── Visual Viewport (mobile keyboard) ──
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      if (!isOpen) return;
      var offset = window.innerHeight - window.visualViewport.height;
      panel.style.bottom = (offset + 8) + 'px';
    });
  }

  // ── Auto tooltip ──
  setTimeout(showTooltip, TOOLTIP_DELAY);

})();
