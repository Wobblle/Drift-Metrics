/* ============================================================================
 * bridge.js v2  //  DriftMetrics frontend ↔ Edge Function + Turnstile
 * ----------------------------------------------------------------------------
 * One file does everything:
 *   - Mounts Cloudflare Turnstile (invisible)
 *   - Mounts a hidden code panel (Ctrl+K / Cmd+K to toggle)
 *   - Persists access codes in localStorage as 'dm_code'
 *   - Sends submit through the Edge Function (NOT direct PostgREST)
 *   - Polls /rest/v1/reports for results (still direct, read-only)
 *   - Cache pre-flight against /rest/v1/reports
 *
 * Wire-up in index.html (TWO patches):
 *
 *   (1) Add inside <head>, before the existing inline <script>:
 *       <script defer src="./bridge.js"></script>
 *
 *   (2) Change `function renderReport(keyword)` to accept external data:
 *       function renderReport(keyword, externalData) {
 *         const data = externalData
 *                    || MOCK[keyword.toLowerCase()]
 *                    || DEFAULT_REPORT(keyword);
 *         ...
 *       }
 *
 * The bridge auto-overrides window.runQuery on DOMContentLoaded. Existing
 * inline behavior (mock + sample queries) is preserved when the bridge
 * can't reach the network — useful for local development.
 * ============================================================================ */

// ---------- CONSTANTS ----------------------------------
const DM_SUPABASE_URL       = 'https://ojrcarvjtzsynchcexmb.supabase.co';
const DM_SUPABASE_ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qcmNhcnZqdHpzeW5jaGNleG1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwMzM5OTYsImV4cCI6MjA5MzYwOTk5Nn0.yxNIgPihQaZH7VNYx7siOpIUIskzh0z6pE1Quc7tguA';
const DM_FUNCTION_URL       = `${DM_SUPABASE_URL}/functions/v1/submit`;
const DM_TURNSTILE_SITEKEY  = '0x4AAAAAADJ5qI9fGwLTfIzf';
// ----------------------------------------------------------------------------

window.DM = (() => {
  const POLL_INTERVAL_MS = 3000;
  const POLL_TIMEOUT_MS  = 45000;
  const CACHE_WINDOW_HRS = 1;
  const CODE_STORAGE_KEY = 'dm_code';

  // ---------- low-level helpers -------------------------------------------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const restHeaders = () => ({
    apikey:        DM_SUPABASE_ANON_KEY,
    Authorization: `Bearer ${DM_SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  });

  function uuid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function readHoneypot() {
    const el = document.getElementById('dm-honeypot');
    return el ? (el.value || '') : '';
  }

  function readStoredCode() {
    try { return (localStorage.getItem(CODE_STORAGE_KEY) || '').trim(); }
    catch (_) { return ''; }
  }

  function writeStoredCode(code) {
    try {
      const v = (code || '').trim().toUpperCase();
      if (v) localStorage.setItem(CODE_STORAGE_KEY, v);
      else   localStorage.removeItem(CODE_STORAGE_KEY);
    } catch (_) { /* private mode etc */ }
  }

  // ---------- Turnstile (invisible) ---------------------------------------
  let _tsWidget = null;
  let _tsPending = null;

  async function _ensureTurnstileLoaded() {
    if (window.turnstile) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = reject;
      document.head.appendChild(s);
    });
    // Wait one frame for window.turnstile to be assigned
    await new Promise(r => setTimeout(r, 50));
  }

  async function mountTurnstile() {
    try {
      await _ensureTurnstileLoaded();
      if (_tsWidget !== null || !window.turnstile) return;

      let container = document.getElementById('dm-turnstile');
      if (!container) {
        container = document.createElement('div');
        container.id = 'dm-turnstile';
        container.style.cssText = 'position:fixed;bottom:-100px;right:-100px;width:0;height:0;overflow:hidden;';
        document.body.appendChild(container);
      }

      _tsWidget = window.turnstile.render(container, {
        sitekey: DM_TURNSTILE_SITEKEY,
        size: 'invisible',
        retry: 'auto',
        'refresh-expired': 'auto',
        callback: (token) => {
          const fn = _tsPending; _tsPending = null;
          if (fn) fn(token);
        },
        'error-callback': () => {
          const fn = _tsPending; _tsPending = null;
          if (fn) fn(null);
        },
        'timeout-callback': () => {
          const fn = _tsPending; _tsPending = null;
          if (fn) fn(null);
        },
      });
    } catch (_e) {
      // If Turnstile is blocked or fails to load, we'll fall through to
      // a null token and the Edge Function will silently reject.
    }
  }

  async function getTurnstileToken() {
    if (!_tsWidget) await mountTurnstile();
    if (!_tsWidget || !window.turnstile) return null;

    return new Promise((resolve) => {
      // If a previous execute is in flight, wait briefly and retry.
      if (_tsPending) {
        setTimeout(() => getTurnstileToken().then(resolve), 200);
        return;
      }
      _tsPending = resolve;
      try {
        window.turnstile.reset(_tsWidget);
        window.turnstile.execute(_tsWidget);
      } catch (_e) {
        _tsPending = null;
        resolve(null);
      }
      // Hard timeout in case Turnstile silently never fires
      setTimeout(() => {
        if (_tsPending === resolve) {
          _tsPending = null;
          resolve(null);
        }
      }, 8000);
    });
  }

  // ---------- supabase REST (read-only paths) -----------------------------
  async function checkCache(keyword) {
    const since = new Date(Date.now() - CACHE_WINDOW_HRS * 3600 * 1000).toISOString();
    const url = `${DM_SUPABASE_URL}/rest/v1/reports`
              + `?keyword=eq.${encodeURIComponent(keyword)}`
              + `&created_at=gt.${encodeURIComponent(since)}`
              + `&select=payload,created_at`
              + `&order=created_at.desc&limit=1`;
    try {
      const r = await fetch(url, { headers: restHeaders() });
      if (!r.ok) return null;
      const rows = await r.json();
      return rows.length ? rows[0].payload : null;
    } catch (_) { return null; }
  }

  async function pollOnce(requestId) {
    const url = `${DM_SUPABASE_URL}/rest/v1/reports`
              + `?request_id=eq.${requestId}`
              + `&select=payload&limit=1`;
    const r = await fetch(url, { headers: restHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows.length ? rows[0].payload : null;
  }

  // ---------- submit via Edge Function ------------------------------------
  async function submit(keyword, requestId) {
    const code = readStoredCode();
    const tsToken = await getTurnstileToken();

    const payload = {
      request_id:      requestId,
      keyword:         keyword,
      honeypot:        readHoneypot(),
      turnstile_token: tsToken || '',
      user_agent:      navigator.userAgent,
    };
    if (code) payload.code = code;

    try {
      const r = await fetch(DM_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Required by Supabase Edge Functions even with --no-verify-jwt
          'Authorization': `Bearer ${DM_SUPABASE_ANON_KEY}`,
          'apikey': DM_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(payload),
      });
      if (!r.ok) return { ok: false };
      const data = await r.json();
      return data || { ok: true };
    } catch (_) { return { ok: false }; }
  }

  // ---------- UI helpers --------------------------------------------------
  function logLine(html, klass = 'text-fg') {
    const log = document.getElementById('calc-log');
    if (!log) return;
    if (!window.__dmStart) window.__dmStart = Date.now();
    const t = ((Date.now() - window.__dmStart) / 1000).toFixed(2);
    const line = document.createElement('div');
    line.innerHTML = `<span class="text-mute">[T+${t}s]</span> <span class="${klass}">${html}</span>`;
    log.appendChild(line);
  }

  function resetCalcUI(keyword, jobShort) {
    const k = document.getElementById('calc-keyword');
    const j = document.getElementById('calc-jobid');
    const l = document.getElementById('calc-log');
    if (k) k.textContent = keyword;
    if (j) j.textContent = jobShort;
    if (l) l.innerHTML = '';
    ['p1','p2','p3'].forEach(id => {
      const el = document.getElementById(id); if (el) el.style.width = '0%';
    });
    ['p1-pct','p2-pct','p3-pct'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '0%';
    });
    window.__dmStart = Date.now();
  }

  // ---------- code panel (hidden until Ctrl+K / Cmd+K) --------------------
  function ensureCodePanel() {
    if (document.getElementById('dm-code-panel')) return;

    // Panel: rendered once, hidden, fixed to top-right of viewport.
    const panel = document.createElement('div');
    panel.id = 'dm-code-panel';
    panel.className = 'hidden fixed z-50';
    panel.style.cssText = 'top:48px;right:24px;width:380px;';
    panel.innerHTML = `
      <div class="border border-amber bg-panel relative" style="box-shadow:0 0 0 1px #FFB000;">
        <div class="flex items-center justify-between px-3 h-7 border-b border-amber mono text-[10px] text-amber">
          <span>ACCESS CODE</span>
          <span class="text-mute">[ESC] CLOSE &middot; [ENTER] APPLY</span>
        </div>
        <div class="px-3 py-3">
          <div class="flex items-center">
            <span class="mono text-amber text-[14px] mr-2">&gt;</span>
            <input id="dm-code-input" type="text" autocomplete="off" spellcheck="false"
                   placeholder="ASL-FOUNDERS-001"
                   maxlength="48"
                   class="mono bg-transparent text-fg text-[14px] w-full placeholder:text-dim focus:outline-none uppercase"
                   style="text-transform:uppercase;letter-spacing:0.05em;" />
          </div>
        </div>
        <div class="px-3 h-6 border-t border-line2 mono text-[10px] text-mute flex items-center justify-between">
          <span id="dm-code-status">status: <span class="text-fg" id="dm-code-status-val">NONE</span></span>
          <span class="text-dim">backspace clear &middot; enter apply</span>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const input = document.getElementById('dm-code-input');
    const statusVal = document.getElementById('dm-code-status-val');

    function refreshStatus() {
      const stored = readStoredCode();
      if (!stored) { statusVal.textContent = 'NONE'; statusVal.className = 'text-fg'; return; }
      const remaining = window.__dmRemaining;
      if (typeof remaining === 'number') {
        statusVal.innerHTML = `<span class="text-amber">${stored}</span> &middot; <span class="text-fg">${remaining} LEFT</span>`;
      } else {
        statusVal.innerHTML = `<span class="text-amber">${stored}</span> &middot; <span class="text-mute">unverified</span>`;
      }
    }

    function open() {
      panel.classList.remove('hidden');
      input.value = readStoredCode();
      refreshStatus();
      setTimeout(() => input.focus(), 30);
    }
    function close() { panel.classList.add('hidden'); }
    function apply() {
      const v = (input.value || '').trim().toUpperCase();
      writeStoredCode(v);
      window.__dmRemaining = undefined; // unverified until next coded scrape
      refreshStatus();
      renderBadge();
      close();
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); apply(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    panel.addEventListener('click', (e) => { if (e.target === panel) close(); });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (panel.classList.contains('hidden')) open(); else close();
      }
    });

    // Expose for tests / debugging
    window.DM_panel = { open, close, apply, refresh: refreshStatus };
  }

  // ---------- code badge in the search rig --------------------------------
  function renderBadge() {
    // Rendered into the top meta-bar of the search rig if a code is stored.
    const target = document.querySelector('#state-search .border.border-line2.bg-panel > div.flex.items-center.justify-between.px-4.h-8.border-b.border-line2');
    // ^ that selector matches the meta bar above the input. Brittle, but
    //   it's a known DOM in our own index.html.
    if (!target) return;

    const existing = document.getElementById('dm-code-badge');
    const stored = readStoredCode();
    if (!stored) { if (existing) existing.remove(); return; }

    const prefix = (stored.match(/^[A-Z]{3}/) || ['?'])[0];
    const remaining = window.__dmRemaining;
    const tail = (typeof remaining === 'number')
      ? `${remaining} LEFT`
      : 'READY';

    let badge = existing;
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'dm-code-badge';
      badge.className = 'mono text-[10px] text-amber border border-amber px-2 py-0.5 ml-3 cursor-pointer';
      badge.title = 'Ctrl+K to edit';
      badge.addEventListener('click', () => window.DM_panel?.open());
      // append to the right-side stack of the meta bar
      const right = target.children[1] || target;
      right.appendChild(badge);
    }
    badge.textContent = `${prefix} · ${tail}`;
  }

  // ---------- public entry point ------------------------------------------
  async function runRemote(rawKeyword) {
    const keyword = (rawKeyword || '').toLowerCase().trim();
    if (!keyword) return;

    const requestId = uuid();
    resetCalcUI(keyword, requestId.slice(0, 8).toUpperCase());
    show('calc');                           // existing function in index.html

    logLine('RESOLVING NODE ASSIGNMENT…');

    // 1. Cache pre-flight (cached-open path; free for everyone).
    const cached = await checkCache(keyword);
    if (cached) {
      logLine('CACHE HIT &middot; rendering pre-computed report', 'text-amber');
      await sleep(450);
      renderReport(keyword, cached);
      show('report');
      return;
    }

    // 2. Submit (coded if storage has a code, otherwise cached-open).
    const stored = readStoredCode();
    logLine(stored
      ? `DISPATCHING CODED SCAN &middot; ${stored.slice(0,3)}-…`
      : `DISPATCHING TO FLEET &middot; req=${requestId.slice(0,8)}`);

    const result = await submit(keyword, requestId);
    if (!result || result.ok === false) {
      logLine('ERR: DISPATCH FAILED', 'text-red');
      return;
    }
    if (result.coded && typeof result.remaining === 'number') {
      window.__dmRemaining = result.remaining;
      renderBadge();
      logLine(`CODE BURNED &middot; ${result.remaining} LEFT`, 'text-amber');
    } else {
      logLine('JOB ACCEPTED &middot; awaiting worker…');
    }

    // 3. Poll for result. 45s ceiling; silent timeout = node timeout.
    const start = Date.now();
    let lastSeenLog = 0;
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const elapsed = (Date.now() - start) / 1000;
      if (elapsed - lastSeenLog >= 9) {
        logLine(`POLL T+${elapsed.toFixed(1)}s &middot; no response yet`);
        lastSeenLog = elapsed;
      }
      try {
        const payload = await pollOnce(requestId);
        if (payload) {
          logLine('NODE RESPONSE LOCKED &middot; rendering displacement report', 'text-amber');
          await sleep(280);
          renderReport(keyword, payload);
          show('report');
          return;
        }
      } catch (_) { /* keep polling */ }
    }

    logLine('ERR: NODE TIMEOUT', 'text-red');
    logLine('       no fleet response within 45s', 'text-red');
    logLine('       try again in a few minutes', 'text-mute');
  }

  // ---------- init --------------------------------------------------------
  function init() {
    ensureCodePanel();
    renderBadge();
    // Fire-and-forget: warm up Turnstile so the first submit isn't slow.
    mountTurnstile();
    // Hook into the existing UI: replace runQuery with our remote version.
    if (typeof window.runQuery === 'function') {
      window.__dmOriginalRunQuery = window.runQuery;
    }
    window.runQuery = async function (keyword) { await runRemote(keyword); };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { runRemote, mountTurnstile, readStoredCode, writeStoredCode };
})();
