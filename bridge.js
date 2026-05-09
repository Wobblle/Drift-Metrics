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
// Expose Supabase config to other pages (browse.html, asc.html, etc.)
window.DM_SUPABASE_URL      = DM_SUPABASE_URL;
window.DM_SUPABASE_ANON_KEY = DM_SUPABASE_ANON_KEY;
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
    applyIdentity();
  }

  // ---------- identity (top-bar) -----------------------------------------
  // Identity is derived purely from the stored code prefix. No accounts,
  // no profiles, no Google. If a code is stored, the identity is the code
  // itself (lowercased prefix) styled like a URI scheme. If no code,
  // it's just `anon`.
  function computeIdentity() {
    const stored = readStoredCode();
    if (!stored) return 'anon';
    const prefix = (stored.match(/^[A-Z]{3}/) || [''])[0].toLowerCase();
    const tail = stored.slice(4).toLowerCase();
    return prefix ? `${prefix}://${tail || '???'}` : 'anon';
  }

  function applyIdentity() {
    const el = document.getElementById('dm-identity');
    if (!el) return;
    el.textContent = computeIdentity();
  }

  // ---------- footer stats (real numbers from Supabase) ------------------
  async function fetchStats() {
    // Three small REST queries, run in parallel. PostgREST exposes count
    // via the Prefer: count=exact header.
    const headers = {
      ...restHeaders(),
      Prefer: 'count=exact',
      Range: '0-0',  // we only want the count, not the rows
    };
    const dayAgo = new Date(Date.now() - 24*3600*1000).toISOString();

    async function getCount(filter = '') {
      const url = `${DM_SUPABASE_URL}/rest/v1/reports?select=id${filter}`;
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      // Total count is in Content-Range: "0-0/N"
      const cr = r.headers.get('content-range') || '0-0/0';
      const total = parseInt(cr.split('/')[1] || '0', 10);
      return Number.isFinite(total) ? total : 0;
    }

    async function getLatest() {
      const url = `${DM_SUPABASE_URL}/rest/v1/reports`
                + `?select=created_at,payload`
                + `&order=created_at.desc&limit=1`;
      const r = await fetch(url, { headers: restHeaders() });
      if (!r.ok) return null;
      const rows = await r.json();
      return rows[0] || null;
    }

    async function getMedianDrift() {
      // Pull a sample of recent drift values and compute median client-side.
      // Cheaper than a server-side percentile and accurate enough.
      const url = `${DM_SUPABASE_URL}/rest/v1/reports`
                + `?select=payload->drift::float`
                + `&order=created_at.desc&limit=200`;
      // ^ PostgREST cast syntax not always supported; fall back to extracting client-side
      const fallback = `${DM_SUPABASE_URL}/rest/v1/reports`
                     + `?select=payload&order=created_at.desc&limit=200`;
      let r = await fetch(url, { headers: restHeaders() });
      if (!r.ok) r = await fetch(fallback, { headers: restHeaders() });
      if (!r.ok) return null;
      const rows = await r.json();
      const drifts = rows
        .map(row => {
          const v = row.drift !== undefined ? row.drift : (row.payload && row.payload.drift);
          return typeof v === 'number' ? v : parseFloat(v);
        })
        .filter(n => Number.isFinite(n))
        .sort((a, b) => a - b);
      if (!drifts.length) return null;
      const mid = Math.floor(drifts.length / 2);
      return drifts.length % 2 ? drifts[mid] : (drifts[mid-1] + drifts[mid]) / 2;
    }

    try {
      const [total, last24h, latest, median] = await Promise.all([
        getCount(),
        getCount(`&created_at=gte.${encodeURIComponent(dayAgo)}`),
        getLatest(),
        getMedianDrift(),
      ]);
      return { total, last24h, latest, median };
    } catch (_e) {
      return null;
    }
  }

  function applyStats(stats) {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = val;
    };
    if (!stats) return;
    if (stats.total !== null && stats.total !== undefined) {
      set('stat-corpora', stats.total.toLocaleString());
    }
    if (stats.last24h !== null && stats.last24h !== undefined) {
      set('stat-queries', stats.last24h.toLocaleString());
    }
    if (typeof stats.median === 'number') {
      set('stat-median-drift',
        `${(stats.median * 100).toFixed(1)}<span class="text-mute text-[14px]">%</span>`);
    }
    if (stats.latest && stats.latest.created_at) {
      const d = new Date(stats.latest.created_at);
      const z = (n) => String(n).padStart(2, '0');
      set('stat-last-refresh',
        `${d.getUTCFullYear()}&minus;${z(d.getUTCMonth()+1)}&minus;${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}Z`);
    }
  }

  // ---------- session history (localStorage, per-device) -----------------
  const HISTORY_KEY = 'dm_history';
  const HISTORY_MAX = 50;

  function readHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function writeHistory(arr) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, HISTORY_MAX)));
    } catch (_) { /* private mode etc */ }
  }

  function appendHistory(entry) {
    const list = readHistory();
    // Dedupe by request_id; if same id already present, replace it.
    const i = list.findIndex(x => x.request_id === entry.request_id);
    if (i >= 0) list.splice(i, 1);
    list.unshift(entry);
    writeHistory(list);
    renderHistory();
  }

  function clearHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch (_) {}
    renderHistory();
  }

  function relativeTime(iso) {
    const then = new Date(iso).getTime();
    const ms = Date.now() - then;
    if (ms < 60_000)        return `${Math.floor(ms/1000)}s ago`;
    if (ms < 3_600_000)     return `${Math.floor(ms/60_000)}m ago`;
    if (ms < 86_400_000)    return `${Math.floor(ms/3_600_000)}h ago`;
    return `${Math.floor(ms/86_400_000)}d ago`;
  }

  function renderHistory() {
    const list = readHistory();
    const wrap = document.getElementById('state-history');
    const ul = document.getElementById('history-list');
    if (!wrap || !ul) return;
    if (!list.length) { wrap.classList.add('hidden'); ul.innerHTML = ''; return; }
    wrap.classList.remove('hidden');
    ul.innerHTML = '';
    for (const e of list) {
      const li = document.createElement('li');
      li.className = 'row px-4 py-2.5 grid grid-cols-[1fr_120px_80px_120px] items-center mono text-[12px] cursor-pointer';
      const driftPct = (typeof e.drift === 'number') ? `${(e.drift*100).toFixed(1)}%` : '—';
      const conf = (typeof e.confidence === 'number') ? `${(e.confidence*100).toFixed(0)}%` : '—';
      li.innerHTML = `
        <div class="truncate text-fg">${e.keyword}</div>
        <div class="text-right tabular-nums text-amber">${driftPct}</div>
        <div class="text-right tabular-nums text-mute">${conf}</div>
        <div class="text-right tabular-nums text-mute">${relativeTime(e.timestamp)}</div>
      `;
      li.addEventListener('click', () => {
        if (e.payload) {
          renderReport(e.keyword, e.payload);
          show('report');
        }
      });
      ul.appendChild(li);
    }
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

  // ---------- code verification (read-only balance lookup) ---------------
  // Hits the peek_code RPC. Returns { ok, remaining, tier, prefix } on
  // success or { ok:false, error } on failure. Network/RPC failures map
  // to null so callers can distinguish "I couldn't reach the server" from
  // "the server says this code is invalid".
  async function peekCode(rawCode) {
    const code = (rawCode || '').trim().toUpperCase();
    if (!code) return { ok: false, error: 'empty' };
    try {
      const r = await fetch(`${DM_SUPABASE_URL}/rest/v1/rpc/peek_code`, {
        method: 'POST',
        headers: restHeaders(),
        body: JSON.stringify({ p_code: code }),
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data || null;
    } catch (_) { return null; }
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
          <span class="flex items-center gap-3">
            <button id="dm-code-share" type="button" class="text-amber hover:underline disabled:text-dim disabled:hover:no-underline" disabled>[SHARE URL]</button>
            <span class="text-dim">enter apply</span>
          </span>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const input = document.getElementById('dm-code-input');
    const statusVal = document.getElementById('dm-code-status-val');
    const shareBtn = document.getElementById('dm-code-share');

    // Build a sharable URL pointing at the report page on this origin.
    function buildShareUrl(code) {
      if (!code) return '';
      const url = new URL('./index.html', window.location.href);
      url.searchParams.set('code', code);
      url.hash = '';
      return url.toString();
    }

    function refreshStatus() {
      const stored = readStoredCode();
      if (!stored) {
        statusVal.textContent = 'NONE';
        statusVal.className = 'text-fg';
        if (shareBtn) { shareBtn.disabled = true; shareBtn.textContent = '[SHARE URL]'; }
        return;
      }
      const remaining = window.__dmRemaining;
      const err = window.__dmCodeError;
      if (err) {
        statusVal.innerHTML = `<span class="text-amber">${stored}</span> &middot; <span class="text-red">${err.toUpperCase()}</span>`;
      } else if (typeof remaining === 'number') {
        const tone = remaining > 0 ? 'text-fg' : 'text-red';
        const label = remaining > 0 ? `${remaining} LEFT` : 'DEPLETED';
        statusVal.innerHTML = `<span class="text-amber">${stored}</span> &middot; <span class="${tone}">${label}</span>`;
      } else if (remaining === 'pending') {
        statusVal.innerHTML = `<span class="text-amber">${stored}</span> &middot; <span class="text-mute">verifying&hellip;</span>`;
      } else {
        statusVal.innerHTML = `<span class="text-amber">${stored}</span> &middot; <span class="text-mute">unverified</span>`;
      }
      if (shareBtn) { shareBtn.disabled = false; shareBtn.textContent = '[SHARE URL]'; }
    }

    if (shareBtn) {
      shareBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const stored = readStoredCode();
        if (!stored) return;
        const url = buildShareUrl(stored);
        try {
          await navigator.clipboard.writeText(url);
          shareBtn.textContent = '[COPIED]';
        } catch (_err) {
          // Clipboard API unavailable (insecure context, etc.). Fall back to
          // selecting the URL in the input so the user can copy manually.
          input.value = url;
          input.focus();
          input.select();
          shareBtn.textContent = '[SELECT+COPY]';
        }
        setTimeout(() => { if (shareBtn) shareBtn.textContent = '[SHARE URL]'; }, 1800);
      });
    }

    function open() {
      panel.classList.remove('hidden');
      input.value = readStoredCode();
      refreshStatus();
      setTimeout(() => input.focus(), 30);
    }
    function close() { panel.classList.add('hidden'); }
    async function apply() {
      const v = (input.value || '').trim().toUpperCase();
      writeStoredCode(v);
      if (!v) {
        window.__dmRemaining = undefined;
        window.__dmCodeError = null;
        refreshStatus();
        renderBadge();
        renderCredits();
        close();
        return;
      }
      // Verify against the server so the user sees their actual balance
      // before we close the panel. Keeps the UI honest about what's stored.
      window.__dmRemaining = 'pending';
      window.__dmCodeError = null;
      refreshStatus();
      renderBadge();
      renderCredits();
      const peek = await peekCode(v);
      if (peek && peek.ok === true) {
        window.__dmRemaining = peek.remaining;
        window.__dmCodeError = null;
      } else if (peek && peek.ok === false) {
        window.__dmRemaining = null;
        window.__dmCodeError = peek.error || 'invalid';
      } else {
        window.__dmRemaining = undefined;
        window.__dmCodeError = 'unreachable';
      }
      refreshStatus();
      renderBadge();
      renderCredits();
      // Close after a short beat so the user sees the verification land.
      setTimeout(close, 900);
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
    const err = window.__dmCodeError;

    let tail, tone;
    if (err) {
      tail = err.toUpperCase();
      tone = 'red';
    } else if (typeof remaining === 'number') {
      if (remaining > 0) { tail = `${remaining} LEFT`; tone = 'amber'; }
      else { tail = 'DEPLETED'; tone = 'red'; }
    } else if (remaining === 'pending') {
      tail = 'CHECKING…'; tone = 'mute';
    } else {
      tail = 'READY'; tone = 'amber';
    }

    let badge = existing;
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'dm-code-badge';
      badge.title = 'Ctrl+K to edit';
      badge.addEventListener('click', () => window.DM_panel?.open());
      const right = target.children[1] || target;
      right.appendChild(badge);
    }
    badge.className = `mono text-[10px] text-${tone} border border-${tone === 'mute' ? 'line2' : tone} px-2 py-0.5 ml-3 cursor-pointer`;
    badge.textContent = `${prefix} · ${tail}`;
  }

  // ---------- credits indicator in the search rig footer -----------------
  // Replaces the old static "CREDITS ∞" line with live state. index.html
  // exposes <span id="dm-credits"> in the search rig's footer for this.
  function renderCredits() {
    const el = document.getElementById('dm-credits');
    if (!el) return;
    const stored = readStoredCode();
    const remaining = window.__dmRemaining;
    const err = window.__dmCodeError;
    if (!stored) {
      el.innerHTML = '<span class="text-mute">no code</span>';
    } else if (err) {
      el.innerHTML = `<span class="text-red">${err.toUpperCase()}</span>`;
    } else if (typeof remaining === 'number') {
      el.innerHTML = `<span class="${remaining > 0 ? 'text-fg' : 'text-red'}">${remaining}</span>`;
    } else if (remaining === 'pending') {
      el.innerHTML = '<span class="text-mute">checking&hellip;</span>';
    } else {
      el.innerHTML = '<span class="text-mute">unverified</span>';
    }
  }

  // ---------- public entry point ------------------------------------------
  async function runRemote(rawKeyword) {
    const keyword = (rawKeyword || '').toLowerCase().trim();
    if (!keyword) return;

    const requestId = uuid();
    resetCalcUI(keyword, requestId.slice(0, 8).toUpperCase());
    document.body.classList.add('has-output');     // compact the search hero
    show('calc');                                  // existing function in index.html

    logLine('RESOLVING NODE ASSIGNMENT…');

    // 1. Cache pre-flight (cached-open path; free for everyone).
    const cached = await checkCache(keyword);
    if (cached) {
      logLine('CACHE HIT &middot; rendering pre-computed report', 'text-amber');
      await sleep(450);
      renderReport(keyword, cached);
      show('report');
      appendHistory({
        request_id: requestId,
        keyword,
        drift:      cached.drift,
        confidence: cached.confidence,
        timestamp:  new Date().toISOString(),
        source:     'cache',
        payload:    cached,
      });
      return;
    }

    // 2. Access gate. Cache hits above are free; a fresh scrape requires
    //    a code with positive balance. Verify against the server so we
    //    don't dispatch a request the backend will silently drop.
    const stored = readStoredCode();
    if (!stored) {
      logLine('NO CACHED REPORT FOR THIS QUERY', 'text-mute');
      logLine('A FRESH SCRAPE REQUIRES AN ACCESS CODE', 'text-red');
      logLine('       press [CTRL+K] to enter your code', 'text-mute');
      return;
    }
    logLine(`VERIFYING CODE &middot; ${stored.slice(0,3)}-…`);
    const peek = await peekCode(stored);
    if (!peek) {
      logLine('ERR: COULD NOT REACH GATEKEEPER', 'text-red');
      logLine('       network or service is briefly unavailable; retry in a moment', 'text-mute');
      return;
    }
    if (peek.ok !== true) {
      const reason = (peek.error || 'invalid').toUpperCase();
      window.__dmRemaining = null;
      window.__dmCodeError = peek.error || 'invalid';
      renderBadge(); renderCredits();
      logLine(`ERR: CODE ${reason}`, 'text-red');
      logLine('       press [CTRL+K] to enter a different code', 'text-mute');
      return;
    }
    if (peek.remaining <= 0) {
      window.__dmRemaining = 0;
      window.__dmCodeError = null;
      renderBadge(); renderCredits();
      logLine('ERR: CODE DEPLETED', 'text-red');
      logLine('       this code is out of scrapes; use a different one', 'text-mute');
      return;
    }
    window.__dmRemaining = peek.remaining;
    window.__dmCodeError = null;
    renderBadge(); renderCredits();
    logLine(`DISPATCHING SCAN &middot; ${stored.slice(0,3)}-…`);

    const result = await submit(keyword, requestId);
    if (!result || result.ok === false) {
      logLine('ERR: DISPATCH FAILED', 'text-red');
      return;
    }
    if (result.coded && typeof result.remaining === 'number') {
      window.__dmRemaining = result.remaining;
      renderBadge();
      renderCredits();
      logLine(`SCRAPE STARTED &middot; ${result.remaining} LEFT`, 'text-amber');
    } else {
      logLine('JOB ACCEPTED &middot; awaiting worker&hellip;');
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
          appendHistory({
            request_id: requestId,
            keyword,
            drift:      payload.drift,
            confidence: payload.confidence,
            timestamp:  new Date().toISOString(),
            source:     stored ? 'coded' : 'open',
            payload,
          });
          // Refresh footer stats so the new report counts immediately
          fetchStats().then(applyStats);
          return;
        }
      } catch (_) { /* keep polling */ }
    }

    logLine('ERR: NODE TIMEOUT', 'text-red');
    logLine('       no fleet response within 45s', 'text-red');
    logLine('       try again in a few minutes', 'text-mute');
  }

  // ---------- init --------------------------------------------------------
  // ASC shape: three uppercase letters, dash, then alphanum/dash/section.
  // Lower-case input is acceptable — it gets uppercased by writeStoredCode.
  // Length capped to match the EDIT panel maxlength so a malicious URL can't
  // stuff localStorage with a giant payload.
  const ASC_CODE_SHAPE = /^[A-Z]{3}-[A-Z0-9§-]{1,44}$/;

  // ---------- URL ?code= ingestion ----------------------------------------
  // Possession-based access: a code in the URL replaces the stored code.
  // Lets anyone share a sticker/QR/Discord link and have the recipient inherit
  // the same compute budget without copy-pasting into the Ctrl+K panel.
  // After ingestion the param is stripped from the URL so it doesn't sit in
  // the address bar or accidentally end up in screenshots / scrollback.
  // Malformed codes are silently dropped (param still stripped) so a bad
  // link can't poison localStorage with garbage.
  function ingestCodeFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (!params.has('code')) return;
      const incoming = (params.get('code') || '').trim().toUpperCase();
      if (incoming && ASC_CODE_SHAPE.test(incoming)) {
        writeStoredCode(incoming);
      }
      params.delete('code');
      const cleanQuery = params.toString();
      const cleanUrl = window.location.pathname
        + (cleanQuery ? '?' + cleanQuery : '')
        + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    } catch (_e) { /* same-origin restrictions can throw; ignore */ }
  }

  // Verify the stored code in the background so the badge / credits show
  // real numbers on page load instead of "READY" / "—". Failure is non-fatal:
  // the gate in runRemote will re-verify before any scrape dispatches.
  async function verifyStoredCodeOnLoad() {
    const stored = readStoredCode();
    if (!stored) { renderCredits(); renderBadge(); return; }
    window.__dmRemaining = 'pending';
    window.__dmCodeError = null;
    renderCredits(); renderBadge();
    const peek = await peekCode(stored);
    if (peek && peek.ok === true) {
      window.__dmRemaining = peek.remaining;
      window.__dmCodeError = null;
    } else if (peek && peek.ok === false) {
      window.__dmRemaining = null;
      window.__dmCodeError = peek.error || 'invalid';
    } else {
      window.__dmRemaining = undefined;
      window.__dmCodeError = null;
    }
    renderCredits(); renderBadge();
  }

  function init() {
    ingestCodeFromUrl();
    ensureCodePanel();
    renderBadge();
    renderCredits();
    applyIdentity();                        // anon or asl://founders-001 etc.
    renderHistory();                        // reveal history if localStorage has rows
    // Wire the [CLEAR] button on the history panel
    const clearBtn = document.getElementById('btn-history-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearHistory);

    // Fetch and populate real footer stats from Supabase (non-blocking)
    fetchStats().then(applyStats);
    // Verify the stored code in the background — non-blocking
    verifyStoredCodeOnLoad();

    // If returning to a session that had output before, leave the search
    // hero compact and surface the most recent history entry.
    if (readHistory().length > 0) {
      document.body.classList.add('has-output');
    }

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

  return {
    // Core runtime (REPORT page)
    runRemote, mountTurnstile,
    // Identity / code management (REPORT, ASC pages)
    readStoredCode, writeStoredCode, applyIdentity, computeIdentity,
    peekCode, renderCredits,
    // Stats + history (REPORT, INDEX pages)
    fetchStats, applyStats,
    readHistory, writeHistory, appendHistory, clearHistory, renderHistory,
    // Init for pages that load bridge.js but don't have a search input
    initIfNeeded: () => {
      if (!document.getElementById('qinput')) {
        // Lightweight init for non-REPORT pages: identity + stats only
        applyIdentity();
        fetchStats().then(applyStats);
      }
    },
  };
})();

// Auto-run lightweight init on pages that aren't the main REPORT page,
// so they get identity + footer stats without needing the full search wiring.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.DM.initIfNeeded?.());
} else {
  window.DM.initIfNeeded?.();
}
