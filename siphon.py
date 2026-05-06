#!/usr/bin/env python3
"""
siphon.py — DriftMetrics Siphon Engine
--------------------------------------
Scrapes an Enclosure SERP (corporate-ranked) and a Baseline corpus
(raw lexical SERP + organic Wikipedia signal), then computes
algorithmic parallax: drift score, subsidy terms, suppressed terms.

Outputs report_{slug}.json compatible with the DriftMetrics dashboard
schema in index.html (drift, metrics, subsidy, suppressed,
enclosureUrls, baselineUrls).

Usage:
    python siphon.py "best running shoes"
    python siphon.py "ai coding assistants" --out ./reports --verbose

Dependencies (pip):
    requests
    beautifulsoup4
    lxml          # optional but recommended; falls back to html.parser

DEPENDENCY-LIGHT BY DESIGN:
    No scikit-learn. No numpy. No spacy. No NLTK. Pure-Python TF-IDF
    so this runs on a vanilla Termux install with two pip packages.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
import time
import urllib.parse
from collections import Counter
from datetime import datetime, timezone
from typing import Dict, List, Tuple

import requests
from bs4 import BeautifulSoup

try:
    import lxml  # noqa: F401
    BS_PARSER = "lxml"
except ImportError:
    BS_PARSER = "html.parser"


# =============================================================================
# CONSTANTS
# =============================================================================

USER_AGENTS = [
    # rotate across a few stable, recent desktop UAs
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 "
    "Firefox/124.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]

ACCEPT_LANGS = ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en;q=0.9"]

# minimal english stopword set — keep it tight, brutalism over completeness
STOPWORDS = set("""
a about after again against all also am an and any are as at be because been
before being below between both but by can could did do does doing down during
each few for from further had has have having he her here hers him his how i
if in into is it its itself just like make many may me might more most must my
no nor not now of off on once one only or other our out over own same shall she
should so some such than that the their them then there these they this those
through to too under until up very was way we well were what when where which
while who whom why will with within would you your yours
""".split())

# "commercial" markers — used for the 'commercial skew' metric
COMMERCIAL_MARKERS = set("""
buy shop deal deals sale price cheapest cheap order checkout cart amazon ebay
walmart target bestbuy promo coupon discount review reviews top best ranking
ranked compared comparison vs versus 2024 2025 2026 affiliate sponsored ad
""".split())


# =============================================================================
# HTTP — UA ROTATION, RETRIES, BACKOFF
# =============================================================================

class Siphon:
    """Thin HTTP wrapper with UA rotation, jittered retries, and a session."""

    def __init__(self, verbose: bool = False, timeout: float = 12.0):
        self.s = requests.Session()
        self.timeout = timeout
        self.verbose = verbose

    def _headers(self, referer: str | None = None) -> Dict[str, str]:
        h = {
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/xml;"
                      "q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": random.choice(ACCEPT_LANGS),
            "Accept-Encoding": "gzip, deflate",
            "DNT": "1",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
        }
        if referer:
            h["Referer"] = referer
        return h

    def get(self, url: str, params: dict | None = None,
            referer: str | None = None, retries: int = 3) -> requests.Response | None:
        last_err = None
        for attempt in range(1, retries + 1):
            try:
                if self.verbose:
                    print(f"  [GET {attempt}/{retries}] {url}", file=sys.stderr)
                r = self.s.get(
                    url, params=params,
                    headers=self._headers(referer=referer),
                    timeout=self.timeout, allow_redirects=True,
                )
                if r.status_code == 200 and r.text:
                    return r
                if r.status_code in (429, 503):
                    time.sleep(1.5 * attempt + random.random())
                    continue
                last_err = f"HTTP {r.status_code}"
            except requests.RequestException as e:
                last_err = repr(e)
                time.sleep(0.7 * attempt + random.random() * 0.6)
        if self.verbose:
            print(f"  [FAIL] {url} :: {last_err}", file=sys.stderr)
        return None

    def post(self, url: str, data: dict, referer: str | None = None,
             retries: int = 3) -> requests.Response | None:
        last_err = None
        for attempt in range(1, retries + 1):
            try:
                r = self.s.post(
                    url, data=data,
                    headers=self._headers(referer=referer),
                    timeout=self.timeout, allow_redirects=True,
                )
                if r.status_code == 200 and r.text:
                    return r
                last_err = f"HTTP {r.status_code}"
                time.sleep(0.7 * attempt + random.random())
            except requests.RequestException as e:
                last_err = repr(e)
                time.sleep(0.7 * attempt + random.random())
        if self.verbose:
            print(f"  [FAIL POST] {url} :: {last_err}", file=sys.stderr)
        return None


# =============================================================================
# ENCLOSURE — Bing primary, Yahoo fallback
# =============================================================================

def _bing_results(http: Siphon, keyword: str, n: int = 10
                  ) -> List[Tuple[str, str, str]]:
    """Return list of (url, title, snippet)."""
    r = http.get("https://www.bing.com/search",
                 params={"q": keyword, "count": max(n, 10), "setlang": "en-US"},
                 referer="https://www.bing.com/")
    if not r:
        return []
    soup = BeautifulSoup(r.text, BS_PARSER)
    out: List[Tuple[str, str, str]] = []
    for li in soup.select("li.b_algo"):
        a = li.select_one("h2 a")
        if not a or not a.get("href"):
            continue
        url = a.get("href").strip()
        title = a.get_text(" ", strip=True)
        snip_el = (li.select_one(".b_caption p") or
                   li.select_one(".b_caption") or
                   li.select_one("p"))
        snippet = snip_el.get_text(" ", strip=True) if snip_el else ""
        out.append((url, title, snippet))
        if len(out) >= n:
            break
    return out


def _yahoo_results(http: Siphon, keyword: str, n: int = 10
                   ) -> List[Tuple[str, str, str]]:
    r = http.get("https://search.yahoo.com/search",
                 params={"p": keyword, "n": n}, referer="https://www.yahoo.com/")
    if not r:
        return []
    soup = BeautifulSoup(r.text, BS_PARSER)
    out: List[Tuple[str, str, str]] = []
    for div in soup.select("div.algo, div.algo-sr"):
        a = div.select_one("h3 a, h3.title a")
        if not a:
            continue
        url = a.get("href", "").strip()
        # yahoo wraps real URLs in r.search.yahoo.com/_ylt=... — strip if present
        if "r.search.yahoo.com" in url:
            m = re.search(r"/RU=([^/]+)/", url)
            if m:
                url = urllib.parse.unquote(m.group(1))
        title = a.get_text(" ", strip=True)
        snip_el = div.select_one(".compText p, p")
        snippet = snip_el.get_text(" ", strip=True) if snip_el else ""
        out.append((url, title, snippet))
        if len(out) >= n:
            break
    return out


def fetch_enclosure(http: Siphon, keyword: str, n: int = 10
                    ) -> Dict:
    """Scrape the corporate SERP. Bing first, Yahoo fallback."""
    if http.verbose:
        print("[ENCLOSURE] bing.com/search", file=sys.stderr)
    rows = _bing_results(http, keyword, n=n)
    source = "bing.com/search"
    if len(rows) < 3:
        if http.verbose:
            print("[ENCLOSURE] bing thin/blocked, trying yahoo",
                  file=sys.stderr)
        rows = _yahoo_results(http, keyword, n=n)
        source = "search.yahoo.com"
    return {
        "source": source,
        "rows": rows[:n],
    }


# =============================================================================
# BASELINE — DDG HTML (raw lexical) + Wikipedia (organic intent)
# =============================================================================

def _ddg_unwrap(href: str) -> str:
    """DDG html wraps URLs as //duckduckgo.com/l/?uddg=<encoded>&rut=..."""
    if not href:
        return href
    if href.startswith("//"):
        href = "https:" + href
    parsed = urllib.parse.urlparse(href)
    if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
        q = urllib.parse.parse_qs(parsed.query)
        if "uddg" in q:
            return urllib.parse.unquote(q["uddg"][0])
    return href


def _ddg_html_results(http: Siphon, keyword: str, n: int = 10
                      ) -> List[Tuple[str, str, str]]:
    """Legacy non-JS DDG endpoint. Highly raw, keyword-literal ranking."""
    # POST works more reliably than GET on this endpoint
    r = http.post("https://html.duckduckgo.com/html/",
                  data={"q": keyword, "kl": "us-en"},
                  referer="https://duckduckgo.com/")
    if not r:
        r = http.get("https://html.duckduckgo.com/html/",
                     params={"q": keyword, "kl": "us-en"},
                     referer="https://duckduckgo.com/")
    if not r:
        return []
    soup = BeautifulSoup(r.text, BS_PARSER)
    out: List[Tuple[str, str, str]] = []
    for div in soup.select("div.result, div.web-result"):
        a = div.select_one("a.result__a")
        if not a:
            continue
        url = _ddg_unwrap(a.get("href", "").strip())
        title = a.get_text(" ", strip=True)
        snip = div.select_one("a.result__snippet, .result__snippet")
        snippet = snip.get_text(" ", strip=True) if snip else ""
        out.append((url, title, snippet))
        if len(out) >= n:
            break
    return out


def _wikipedia_signal(http: Siphon, keyword: str, n: int = 6
                      ) -> List[Tuple[str, str, str]]:
    """
    Wikipedia is organic human intent — articles surface from edit
    activity and reader pageviews, not commercial bidding. We pull
    OpenSearch results then summary extracts for each.
    """
    api = "https://en.wikipedia.org/w/api.php"
    r = http.get(api, params={
        "action": "opensearch", "search": keyword,
        "limit": n, "namespace": 0, "format": "json",
    }, referer="https://en.wikipedia.org/")
    if not r:
        return []
    try:
        data = r.json()
    except ValueError:
        return []
    if not isinstance(data, list) or len(data) < 4:
        return []
    titles, descs, urls = data[1], data[2], data[3]
    out: List[Tuple[str, str, str]] = []
    for title, desc, url in zip(titles, descs, urls):
        # try to fatten the snippet via REST summary; ignore on failure
        snippet = desc or ""
        try:
            slug = urllib.parse.quote(title.replace(" ", "_"))
            sr = http.get(
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{slug}",
                referer="https://en.wikipedia.org/",
            )
            if sr is not None:
                j = sr.json()
                extract = j.get("extract") or ""
                if extract:
                    snippet = extract
        except Exception:
            pass
        out.append((url, title, snippet))
        if len(out) >= n:
            break
    return out


def fetch_baseline(http: Siphon, keyword: str, n: int = 10,
                   include_wiki: bool = True) -> Dict:
    """Pull raw lexical SERP + organic Wikipedia signal."""
    if http.verbose:
        print("[BASELINE] html.duckduckgo.com/html/", file=sys.stderr)
    ddg = _ddg_html_results(http, keyword, n=n)
    wiki: List[Tuple[str, str, str]] = []
    if include_wiki:
        if http.verbose:
            print("[BASELINE] wikipedia opensearch + summary",
                  file=sys.stderr)
        wiki = _wikipedia_signal(http, keyword, n=6)
    # combine; prefer ddg ordering for the displayed list, but
    # corpus text uses both
    combined_rows = ddg[:n]
    return {
        "source": "html.duckduckgo.com + wikipedia.org",
        "rows": combined_rows,
        "wiki": wiki,
    }


# =============================================================================
# NLP — TOKENIZER + PURE-PYTHON TF-IDF
# =============================================================================

_TOKEN_RE = re.compile(r"[a-z][a-z0-9'\-]+")


def tokenize(text: str) -> List[str]:
    text = (text or "").lower()
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[\W_]+", " ", text, flags=re.UNICODE)
    toks = _TOKEN_RE.findall(text)
    return [t for t in toks
            if len(t) >= 3 and t not in STOPWORDS and not t.isdigit()]


def doc_text(rows: List[Tuple[str, str, str]]) -> str:
    """Concatenate (title + snippet) for each result row."""
    parts: List[str] = []
    for _url, title, snip in rows:
        parts.append(title or "")
        parts.append(snip or "")
    return "\n".join(parts)


def tfidf(corpora: Dict[str, List[str]]
          ) -> Tuple[Dict[str, int], Dict[str, List[float]]]:
    """
    Pure-python TF-IDF.

    Input: { corpus_name: [tokens, ...], ... }
    Output:
        vocab: {term: idx}
        vectors: {corpus_name: [tfidf weights aligned to vocab]}
    """
    # build vocab + df across all corpora (each corpus = 1 document here)
    df: Counter = Counter()
    tfs: Dict[str, Counter] = {}
    for name, toks in corpora.items():
        tf = Counter(toks)
        tfs[name] = tf
        for term in tf:
            df[term] += 1
    vocab: Dict[str, int] = {t: i for i, t in enumerate(sorted(df))}
    N = max(1, len(corpora))
    V = len(vocab)
    vectors: Dict[str, List[float]] = {}
    for name, tf in tfs.items():
        vec = [0.0] * V
        total = sum(tf.values()) or 1
        for term, count in tf.items():
            tf_norm = count / total
            idf = math.log((1.0 + N) / (1.0 + df[term])) + 1.0
            vec[vocab[term]] = tf_norm * idf
        vectors[name] = vec
    return vocab, vectors


def cosine(a: List[float], b: List[float]) -> float:
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0 or nb == 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / max(1, len(a | b))


# =============================================================================
# PARALLAX — drift, subsidy, suppressed, metrics
# =============================================================================

def calculate_parallax(enclosure: Dict, baseline: Dict,
                       top_terms: int = 8) -> Dict:
    """
    Compute drift score + breakdown metrics + subsidy/suppressed lists.
    """
    enc_rows = enclosure["rows"]
    base_rows = baseline["rows"] + baseline.get("wiki", [])

    enc_text = doc_text(enc_rows)
    base_text = doc_text(base_rows)
    enc_toks = tokenize(enc_text)
    base_toks = tokenize(base_text)

    # ---- TF-IDF over the two corpora ------------------------------------
    vocab, vecs = tfidf({"E": enc_toks, "B": base_toks})
    inv_vocab = {i: t for t, i in vocab.items()}
    vE, vB = vecs["E"], vecs["B"]

    # ---- semantic delta (cosine) ----------------------------------------
    cos = cosine(vE, vB)
    sem_delta = max(0.0, min(1.0, 1.0 - cos))

    # ---- lexical delta (jaccard over vocab present in each side) --------
    enc_terms = {inv_vocab[i] for i, w in enumerate(vE) if w > 0}
    base_terms = {inv_vocab[i] for i, w in enumerate(vB) if w > 0}
    jac = jaccard(enc_terms, base_terms)
    lex_delta = max(0.0, min(1.0, 1.0 - jac))

    # ---- doc overlap (URL host overlap) ---------------------------------
    enc_hosts = {urllib.parse.urlparse(u).netloc.replace("www.", "")
                 for u, _t, _s in enc_rows if u}
    base_hosts = {urllib.parse.urlparse(u).netloc.replace("www.", "")
                  for u, _t, _s in base_rows if u}
    ovl = jaccard(enc_hosts, base_hosts)

    # ---- commercial skew (heuristic) ------------------------------------
    def commercial_share(toks: List[str]) -> float:
        if not toks:
            return 0.0
        hits = sum(1 for t in toks if t in COMMERCIAL_MARKERS)
        return hits / len(toks)

    enc_com = commercial_share(enc_toks)
    base_com = commercial_share(base_toks)
    # normalize to a 0-1 scale that emphasizes the *gap* enclosure->baseline
    com_skew = max(0.0, min(1.0, (enc_com - base_com) * 25.0 + 0.5))

    # ---- subsidy / suppression ------------------------------------------
    # term_score(side) = tfidf_side * (1 - tfidf_other / max(eps, tfidf_side))
    # (large where side is high AND other is low)
    eps = 1e-9
    enc_counter = Counter(enc_toks)
    base_counter = Counter(base_toks)

    def asymmetry_terms(side_vec: List[float], other_vec: List[float],
                        side_counts: Counter) -> List[Tuple[str, float, int]]:
        scored: List[Tuple[float, str, int]] = []
        for i, w in enumerate(side_vec):
            if w <= 0:
                continue
            term = inv_vocab[i]
            if term in COMMERCIAL_MARKERS and side_vec is vB:
                # don't surface commercial markers as "suppressed"
                continue
            other_w = other_vec[i]
            asym = w * (1.0 - other_w / (w + eps))
            if asym <= 0:
                continue
            scored.append((asym, term, side_counts.get(term, 0)))
        scored.sort(reverse=True)
        # normalize asym to [0, 1] for display weight
        if not scored:
            return []
        max_a = scored[0][0] or 1.0
        out: List[Tuple[str, float, int]] = []
        for asym, term, count in scored[:top_terms]:
            out.append((term, round(asym / max_a, 3), int(count)))
        return out

    subsidy = asymmetry_terms(vE, vB, enc_counter)
    suppressed = asymmetry_terms(vB, vE, base_counter)

    sub_mass = sum(w for _t, w, _c in subsidy) / max(1, len(subsidy))
    sup_mass = sum(w for _t, w, _c in suppressed) / max(1, len(suppressed))

    # ---- composite drift score ------------------------------------------
    # weighted blend; sem dominates, lex/overlap shape it, commercial nudges
    drift = (
        0.55 * sem_delta +
        0.20 * lex_delta +
        0.15 * (1.0 - ovl) +
        0.10 * com_skew
    )
    drift = max(0.0, min(1.0, drift))

    # ---- confidence: penalize tiny corpora ------------------------------
    size_penalty = min(1.0, (len(enc_toks) + len(base_toks)) / 1200.0)
    diversity = min(1.0, (len(enc_terms) + len(base_terms)) / 600.0)
    confidence = round(0.55 * size_penalty + 0.45 * diversity, 3)

    return {
        "drift": round(drift, 4),
        "metrics": {
            "lex": round(lex_delta, 3),
            "sem": round(sem_delta, 3),
            "sub": round(min(1.0, sub_mass), 3),
            "sup": round(min(1.0, sup_mass), 3),
            "ovl": round(ovl, 3),
            "com": round(com_skew, 3),
        },
        "confidence": confidence,
        "subsidy": [list(x) for x in subsidy],
        "suppressed": [list(x) for x in suppressed],
        "_debug": {
            "enclosure_tokens": len(enc_toks),
            "baseline_tokens": len(base_toks),
            "vocab_size": len(vocab),
            "cosine": round(cos, 4),
        },
    }


# =============================================================================
# OUTPUT — schema-compatible JSON
# =============================================================================

def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "report"


def build_report(keyword: str, enclosure: Dict, baseline: Dict,
                 parallax: Dict) -> Dict:
    """Assemble the JSON object that index.html's MOCK schema expects."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    enc_urls = [[u, t] for (u, t, _s) in enclosure["rows"][:5]]
    base_urls = [[u, t] for (u, t, _s) in baseline["rows"][:5]]
    return {
        "keyword": keyword,
        "timestamp": ts,
        "enclosure": enclosure["source"],
        "baseline": baseline["source"],
        "drift": parallax["drift"],
        "metrics": parallax["metrics"],
        "confidence": parallax["confidence"],
        "subsidy": parallax["subsidy"],
        "suppressed": parallax["suppressed"],
        "enclosureUrls": enc_urls,
        "baselineUrls": base_urls,
        "_debug": parallax.get("_debug", {}),
    }


def export_json(report: Dict, keyword: str, out_dir: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"report_{slugify(keyword)}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    return path


# =============================================================================
# CLI
# =============================================================================

def main(argv: List[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="siphon",
        description="DriftMetrics Siphon Engine — generate a Displacement "
                    "Report JSON for a target keyword.",
    )
    p.add_argument("keyword", help="target keyword to scan")
    p.add_argument("--out", default=".", help="output directory")
    p.add_argument("--max-results", type=int, default=10,
                   help="max URLs per source (default 10)")
    p.add_argument("--top-terms", type=int, default=8,
                   help="size of subsidy/suppressed lists (default 8)")
    p.add_argument("--no-wiki", action="store_true",
                   help="skip Wikipedia signal in baseline")
    p.add_argument("--verbose", action="store_true",
                   help="log progress to stderr")
    args = p.parse_args(argv)

    t0 = time.time()
    http = Siphon(verbose=args.verbose)

    enclosure = fetch_enclosure(http, args.keyword, n=args.max_results)
    baseline = fetch_baseline(http, args.keyword, n=args.max_results,
                              include_wiki=not args.no_wiki)

    if not enclosure["rows"]:
        print("[!] enclosure returned 0 rows — likely blocked. "
              "Try again later or rotate exit IP.", file=sys.stderr)
    if not baseline["rows"]:
        print("[!] baseline returned 0 rows — DDG html may be blocking. "
              "Re-run with --verbose to see status.", file=sys.stderr)

    parallax = calculate_parallax(enclosure, baseline, top_terms=args.top_terms)
    report = build_report(args.keyword, enclosure, baseline, parallax)
    path = export_json(report, args.keyword, args.out)

    elapsed = time.time() - t0
    print(json.dumps({
        "report": path,
        "keyword": args.keyword,
        "drift": report["drift"],
        "confidence": report["confidence"],
        "enclosure_rows": len(enclosure["rows"]),
        "baseline_rows": len(baseline["rows"]),
        "wiki_rows": len(baseline.get("wiki", [])),
        "elapsed_s": round(elapsed, 2),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
