// ============================================================================
// siphon.ts — DriftMetrics scraping engine, Deno/Acurast port of siphon.py
// ----------------------------------------------------------------------------
// Pure TypeScript. Bundles cleanly to a single file via `deno bundle`.
// Dependencies (resolved at bundle time, not runtime):
//   linkedom   — pure-JS HTML parser, supports querySelector / querySelectorAll
//
// Public API:
//   runScan(keyword): Promise<DisplacementReport>
//
// The shape of DisplacementReport matches the JSON the existing index.html
// dashboard already consumes (drift, metrics, subsidy, suppressed,
// enclosureUrls, baselineUrls, …).
// ============================================================================
//
// HTML PARSER CHOICE — read before deploying:
//
// We use `linkedom` (pure JS) by default because it bundles to a single
// static file with no runtime imports — friction-free for the TEE.
//
// Most Acurast example code in the wild uses `deno-dom` instead. Both
// libraries expose identical CSS-selector APIs (querySelector,
// querySelectorAll) — the *only* differences are the import line and
// the parse function name. If linkedom fails to bundle or load in your
// TEE runtime, swap with these two edits:
//
//   1. Change the import below to:
//        import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";
//
//   2. Replace the small `parseHTML` shim at the bottom of this header
//      with:
//        const parser = new DOMParser();
//        function parseHTML(html: string) {
//          const document = parser.parseFromString(html, "text/html");
//          return { document };
//        }
//
// All selector calls below stay unchanged.
// ============================================================================

import { parseHTML } from "npm:linkedom@0.16.11";

// ============================================================================
// CONSTANTS
// ============================================================================

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 " +
    "Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

const ACCEPT_LANGS = ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en;q=0.9"];

const STOPWORDS = new Set(
  `a about after again against all also am an and any are as at be because been
  before being below between both but by can could did do does doing down during
  each few for from further had has have having he her here hers him his how i
  if in into is it its itself just like make many may me might more most must my
  no nor not now of off on once one only or other our out over own same shall she
  should so some such than that the their them then there these they this those
  through to too under until up very was way we well were what when where which
  while who whom why will with within would you your yours`.split(/\s+/),
);

const COMMERCIAL_MARKERS = new Set(
  `buy shop deal deals sale price cheapest cheap order checkout cart amazon ebay
  walmart target bestbuy promo coupon discount review reviews top best ranking
  ranked compared comparison vs versus 2024 2025 2026 affiliate sponsored ad`
    .split(/\s+/),
);

// ============================================================================
// TYPES
// ============================================================================

export type Row = [string, string, string]; // [url, title, snippet]

export interface EnclosureCorpus {
  source: string;
  rows: Row[];
}

export interface BaselineCorpus {
  source: string;
  rows: Row[];
  wiki: Row[];
}

export interface ParallaxResult {
  drift: number;
  metrics: {
    lex: number; sem: number; sub: number;
    sup: number; ovl: number; com: number;
  };
  confidence: number;
  subsidy: [string, number, number][];
  suppressed: [string, number, number][];
  _debug: Record<string, unknown>;
}

export interface DisplacementReport {
  keyword: string;
  timestamp: string;
  enclosure: string;
  baseline: string;
  drift: number;
  metrics: ParallaxResult["metrics"];
  confidence: number;
  subsidy: [string, number, number][];
  suppressed: [string, number, number][];
  enclosureUrls: [string, string][];
  baselineUrls: [string, string][];
  _debug?: Record<string, unknown>;
}

// ============================================================================
// HTTP — UA ROTATION, RETRIES, JITTERED BACKOFF (mirrors Siphon class)
// ============================================================================

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function buildHeaders(referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": pick(USER_AGENTS),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9," +
      "image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": pick(ACCEPT_LANGS),
    "Accept-Encoding": "gzip, deflate",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
  if (referer) h["Referer"] = referer;
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function siphonGet(
  url: string,
  params?: Record<string, string>,
  referer?: string,
  retries = 3,
  timeoutMs = 12_000,
): Promise<string | null> {
  const u = new URL(url);
  if (params) {
    for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(u.toString(), {
        method: "GET",
        headers: buildHeaders(referer),
        redirect: "follow",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.ok) return await r.text();
      if (r.status === 429 || r.status === 503) {
        await sleep(1500 * attempt + Math.random() * 1000);
        continue;
      }
    } catch (_e) {
      clearTimeout(t);
      await sleep(700 * attempt + Math.random() * 600);
    }
  }
  return null;
}

async function siphonPost(
  url: string,
  data: Record<string, string>,
  referer?: string,
  retries = 3,
  timeoutMs = 12_000,
): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(data)) form.append(k, v);
      const r = await fetch(url, {
        method: "POST",
        headers: {
          ...buildHeaders(referer),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        redirect: "follow",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.ok) return await r.text();
    } catch (_e) {
      clearTimeout(t);
      await sleep(700 * attempt + Math.random() * 600);
    }
  }
  return null;
}

// ============================================================================
// HTML PARSING — selectors are 1:1 with siphon.py's bs4 selectors
// ============================================================================

function textOf(el: Element | null): string {
  if (!el) return "";
  return (el.textContent || "").trim().replace(/\s+/g, " ");
}

function bingResults(html: string, n = 10): Row[] {
  const { document } = parseHTML(html);
  const out: Row[] = [];
  for (const li of document.querySelectorAll("li.b_algo")) {
    const a = li.querySelector("h2 a") as Element | null;
    const url = a?.getAttribute("href")?.trim() || "";
    if (!url) continue;
    const title = textOf(a);
    const snip = li.querySelector(".b_caption p") ||
      li.querySelector(".b_caption") || li.querySelector("p");
    out.push([url, title, textOf(snip as Element | null)]);
    if (out.length >= n) break;
  }
  return out;
}

function yahooResults(html: string, n = 10): Row[] {
  const { document } = parseHTML(html);
  const out: Row[] = [];
  for (const div of document.querySelectorAll("div.algo, div.algo-sr")) {
    const a = div.querySelector("h3 a, h3.title a") as Element | null;
    if (!a) continue;
    let url = a.getAttribute("href") || "";
    // Yahoo wraps real URLs as r.search.yahoo.com/_ylt=…/RU=<encoded>/RK=…
    if (url.includes("r.search.yahoo.com")) {
      const m = url.match(/\/RU=([^/]+)\//);
      if (m) url = decodeURIComponent(m[1]);
    }
    const title = textOf(a);
    const snip = div.querySelector(".compText p, p");
    out.push([url, title, textOf(snip as Element | null)]);
    if (out.length >= n) break;
  }
  return out;
}

function ddgUnwrap(href: string): string {
  if (!href) return href;
  if (href.startsWith("//")) href = "https:" + href;
  try {
    const u = new URL(href);
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname.startsWith("/l/")) {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
  } catch (_e) { /* malformed url, return as-is */ }
  return href;
}

function ddgHtmlResults(html: string, n = 10): Row[] {
  const { document } = parseHTML(html);
  const out: Row[] = [];
  for (const div of document.querySelectorAll("div.result, div.web-result")) {
    const a = div.querySelector("a.result__a") as Element | null;
    if (!a) continue;
    const url = ddgUnwrap((a.getAttribute("href") || "").trim());
    const title = textOf(a);
    const snip = div.querySelector("a.result__snippet, .result__snippet");
    out.push([url, title, textOf(snip as Element | null)]);
    if (out.length >= n) break;
  }
  return out;
}

// ============================================================================
// ENCLOSURE — Bing primary, Yahoo fallback
// ============================================================================

export async function fetchEnclosure(
  keyword: string,
  n = 10,
): Promise<EnclosureCorpus> {
  const html = await siphonGet(
    "https://www.bing.com/search",
    { q: keyword, count: String(Math.max(n, 10)), setlang: "en-US" },
    "https://www.bing.com/",
  );
  let rows: Row[] = html ? bingResults(html, n) : [];
  let source = "bing.com/search";
  if (rows.length < 3) {
    const y = await siphonGet(
      "https://search.yahoo.com/search",
      { p: keyword, n: String(n) },
      "https://www.yahoo.com/",
    );
    rows = y ? yahooResults(y, n) : rows;
    source = "search.yahoo.com";
  }
  return { source, rows: rows.slice(0, n) };
}

// ============================================================================
// BASELINE — DDG html (raw lexical) + Wikipedia (organic intent)
// ============================================================================

async function ddgHtmlFetch(keyword: string, n: number): Promise<Row[]> {
  let html = await siphonPost(
    "https://html.duckduckgo.com/html/",
    { q: keyword, kl: "us-en" },
    "https://duckduckgo.com/",
  );
  if (!html) {
    html = await siphonGet(
      "https://html.duckduckgo.com/html/",
      { q: keyword, kl: "us-en" },
      "https://duckduckgo.com/",
    );
  }
  return html ? ddgHtmlResults(html, n) : [];
}

async function wikipediaSignal(keyword: string, n = 6): Promise<Row[]> {
  const api = "https://en.wikipedia.org/w/api.php";
  const r = await siphonGet(api, {
    action: "opensearch", search: keyword,
    limit: String(n), namespace: "0", format: "json",
  }, "https://en.wikipedia.org/");
  if (!r) return [];
  let data: unknown;
  try { data = JSON.parse(r); } catch { return []; }
  if (!Array.isArray(data) || data.length < 4) return [];
  const titles = data[1] as string[];
  const descs = data[2] as string[];
  const urls = data[3] as string[];
  const out: Row[] = [];
  for (let i = 0; i < titles.length && out.length < n; i++) {
    const title = titles[i];
    const desc = descs[i] || "";
    const url = urls[i];
    let snippet = desc;
    try {
      const slug = encodeURIComponent(title.replace(/\s+/g, "_"));
      const sr = await siphonGet(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`,
        undefined, "https://en.wikipedia.org/",
      );
      if (sr) {
        const j = JSON.parse(sr);
        if (j?.extract) snippet = j.extract as string;
      }
    } catch (_e) { /* ignore — keep desc */ }
    out.push([url, title, snippet]);
  }
  return out;
}

export async function fetchBaseline(
  keyword: string, n = 10, includeWiki = true,
): Promise<BaselineCorpus> {
  const ddg = await ddgHtmlFetch(keyword, n);
  const wiki = includeWiki ? await wikipediaSignal(keyword, 6) : [];
  return {
    source: "html.duckduckgo.com + wikipedia.org",
    rows: ddg.slice(0, n),
    wiki,
  };
}

// ============================================================================
// NLP — TOKENIZER + PURE-TS TF-IDF (1:1 port of siphon.py's pure-Python impl)
// ============================================================================

const TOKEN_RE = /[a-z][a-z0-9'\-]+/g;

export function tokenize(text: string): string[] {
  let t = (text || "").toLowerCase();
  t = t.replace(/https?:\/\/\S+/g, " ");
  t = t.replace(/[\W_]+/gu, " ");
  const matches = t.match(TOKEN_RE) || [];
  return matches.filter((s) =>
    s.length >= 3 && !STOPWORDS.has(s) && !/^\d+$/.test(s)
  );
}

function docText(rows: Row[]): string {
  const parts: string[] = [];
  for (const [, title, snip] of rows) {
    parts.push(title || "");
    parts.push(snip || "");
  }
  return parts.join("\n");
}

export interface TfidfResult {
  vocab: Map<string, number>;
  vectors: Map<string, number[]>;
}

export function tfidf(corpora: Record<string, string[]>): TfidfResult {
  const df = new Map<string, number>();
  const tfs = new Map<string, Map<string, number>>();
  for (const [name, toks] of Object.entries(corpora)) {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    tfs.set(name, tf);
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  // sort vocabulary deterministically — same ordering as Python's sorted(df)
  const vocab = new Map<string, number>();
  const sortedTerms = [...df.keys()].sort();
  for (let i = 0; i < sortedTerms.length; i++) vocab.set(sortedTerms[i], i);
  const N = Math.max(1, Object.keys(corpora).length);
  const V = vocab.size;
  const vectors = new Map<string, number[]>();
  for (const [name, tf] of tfs) {
    const vec = new Array(V).fill(0) as number[];
    let total = 0;
    for (const c of tf.values()) total += c;
    total = total || 1;
    for (const [term, count] of tf) {
      const tfNorm = count / total;
      const idf = Math.log((1 + N) / (1 + (df.get(term) || 0))) + 1.0;
      vec[vocab.get(term)!] = tfNorm * idf;
    }
    vectors.set(name, vec);
  }
  return { vocab, vectors };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ============================================================================
// PARALLAX — drift, subsidy, suppressed, metrics (1:1 port)
// ============================================================================

export function calculateParallax(
  enclosure: EnclosureCorpus,
  baseline: BaselineCorpus,
  topTerms = 8,
): ParallaxResult {
  const encRows = enclosure.rows;
  const baseRows = [...baseline.rows, ...baseline.wiki];

  const encText  = docText(encRows);
  const baseTextS = docText(baseRows);
  const encToks  = tokenize(encText);
  const baseToks = tokenize(baseTextS);

  const { vocab, vectors } = tfidf({ E: encToks, B: baseToks });
  const invVocab = new Map<number, string>();
  for (const [term, i] of vocab) invVocab.set(i, term);
  const vE = vectors.get("E")!;
  const vB = vectors.get("B")!;

  // semantic delta (cosine)
  const cos = cosine(vE, vB);
  const semDelta = Math.max(0, Math.min(1, 1 - cos));

  // lexical delta (Jaccard over present terms)
  const encTerms  = new Set<string>();
  const baseTerms = new Set<string>();
  for (let i = 0; i < vE.length; i++) {
    if (vE[i] > 0) encTerms.add(invVocab.get(i)!);
    if (vB[i] > 0) baseTerms.add(invVocab.get(i)!);
  }
  const jac = jaccard(encTerms, baseTerms);
  const lexDelta = Math.max(0, Math.min(1, 1 - jac));

  // doc overlap (host Jaccard)
  const hostOf = (u: string) => {
    try { return new URL(u).hostname.replace(/^www\./, ""); }
    catch { return ""; }
  };
  const encHosts  = new Set(encRows.map((r) => hostOf(r[0])).filter(Boolean));
  const baseHosts = new Set(baseRows.map((r) => hostOf(r[0])).filter(Boolean));
  const ovl = jaccard(encHosts, baseHosts);

  // commercial skew (heuristic)
  const commercialShare = (toks: string[]) => {
    if (!toks.length) return 0;
    let hits = 0;
    for (const t of toks) if (COMMERCIAL_MARKERS.has(t)) hits++;
    return hits / toks.length;
  };
  const encCom = commercialShare(encToks);
  const baseCom = commercialShare(baseToks);
  const comSkew = Math.max(0, Math.min(1, (encCom - baseCom) * 25 + 0.5));

  // subsidy / suppression
  const eps = 1e-9;
  const encCounter  = new Map<string, number>();
  const baseCounter = new Map<string, number>();
  for (const t of encToks)  encCounter.set(t,  (encCounter.get(t)  || 0) + 1);
  for (const t of baseToks) baseCounter.set(t, (baseCounter.get(t) || 0) + 1);

  function asymmetryTerms(
    sideVec: number[], otherVec: number[],
    sideCounts: Map<string, number>, sideIsBaseline: boolean,
  ): [string, number, number][] {
    const scored: { asym: number; term: string; count: number }[] = [];
    for (let i = 0; i < sideVec.length; i++) {
      const w = sideVec[i];
      if (w <= 0) continue;
      const term = invVocab.get(i)!;
      // Don't surface commercial markers as "suppressed" — they're noise here
      if (term && COMMERCIAL_MARKERS.has(term) && sideIsBaseline) continue;
      const otherW = otherVec[i] || 0;
      const asym = w * (1 - otherW / (w + eps));
      if (asym <= 0) continue;
      scored.push({ asym, term, count: sideCounts.get(term) || 0 });
    }
    scored.sort((a, b) => b.asym - a.asym);
    if (!scored.length) return [];
    const maxA = scored[0].asym || 1;
    return scored.slice(0, topTerms).map(({ asym, term, count }) =>
      [term, Math.round((asym / maxA) * 1000) / 1000, count]
    );
  }

  const subsidy    = asymmetryTerms(vE, vB, encCounter,  false);
  const suppressed = asymmetryTerms(vB, vE, baseCounter, true);

  const subMass = subsidy.length
    ? subsidy.reduce((s, x) => s + x[1], 0) / subsidy.length : 0;
  const supMass = suppressed.length
    ? suppressed.reduce((s, x) => s + x[1], 0) / suppressed.length : 0;

  const drift = Math.max(0, Math.min(1,
    0.55 * semDelta + 0.20 * lexDelta + 0.15 * (1 - ovl) + 0.10 * comSkew,
  ));

  const sizePenalty = Math.min(1, (encToks.length + baseToks.length) / 1200);
  const diversity   = Math.min(1, (encTerms.size + baseTerms.size) / 600);
  const confidence  = Math.round((0.55 * sizePenalty + 0.45 * diversity) * 1000) / 1000;

  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const r4 = (n: number) => Math.round(n * 10000) / 10000;

  return {
    drift: r4(drift),
    metrics: {
      lex: r3(lexDelta),
      sem: r3(semDelta),
      sub: r3(Math.min(1, subMass)),
      sup: r3(Math.min(1, supMass)),
      ovl: r3(ovl),
      com: r3(comSkew),
    },
    confidence,
    subsidy,
    suppressed,
    _debug: {
      enclosure_tokens: encToks.length,
      baseline_tokens:  baseToks.length,
      vocab_size:       vocab.size,
      cosine:           r4(cos),
    },
  };
}

// ============================================================================
// REPORT ASSEMBLY
// ============================================================================

function nowISO(): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth()+1)}-${z(d.getUTCDate())}T` +
    `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}Z`;
}

export function buildReport(
  keyword: string, enclosure: EnclosureCorpus,
  baseline: BaselineCorpus, parallax: ParallaxResult,
): DisplacementReport {
  return {
    keyword,
    timestamp: nowISO(),
    enclosure: enclosure.source,
    baseline:  baseline.source,
    drift:     parallax.drift,
    metrics:   parallax.metrics,
    confidence: parallax.confidence,
    subsidy:    parallax.subsidy,
    suppressed: parallax.suppressed,
    enclosureUrls: enclosure.rows.slice(0, 5).map((r) => [r[0], r[1]] as [string, string]),
    baselineUrls:  baseline.rows.slice(0, 5).map((r) => [r[0], r[1]] as [string, string]),
    _debug: parallax._debug,
  };
}

// ============================================================================
// PUBLIC ENTRY
// ============================================================================

export async function runScan(keyword: string): Promise<DisplacementReport> {
  const enclosure = await fetchEnclosure(keyword);
  const baseline  = await fetchBaseline(keyword);
  const parallax  = calculateParallax(enclosure, baseline);
  return buildReport(keyword, enclosure, baseline, parallax);
}
