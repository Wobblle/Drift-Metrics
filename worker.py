#!/usr/bin/env python3
"""
worker.py — DriftMetrics fleet worker daemon
============================================

Runs on each Termux/Ubuntu node. Loops forever:

    1. Sleep with jitter (so the fleet doesn't sync up)
    2. POST /rest/v1/rpc/claim_next_job   → claim one pending row
    3. subprocess: python3 siphon.py <keyword> --out /tmp/dm-worker
    4. POST /rest/v1/reports              → publish the JSON report
    5. DELETE /rest/v1/query_queue?id=eq  → keep the queue table near zero

Uses the SERVICE-ROLE key (not the anon key). Bypasses RLS. This file
must NEVER ship to the browser.

Environment:
    SUPABASE_URL          required, e.g. https://xxx.supabase.co
    SUPABASE_SERVICE_KEY  required, eyJ...
    SIPHON_PATH           default ./siphon.py
    WORKER_ID             default "phone-<random>"
    POLL_MIN              default 8     seconds
    POLL_MAX              default 30    seconds
    SIPHON_TIMEOUT        default 180   seconds

Dependencies:
    pip install requests
"""

from __future__ import annotations

import json
import os
import random
import re
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

import requests

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

SUPABASE_URL    = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY    = os.environ.get("SUPABASE_SERVICE_KEY", "")
SIPHON_PATH     = os.environ.get("SIPHON_PATH", "./siphon.py")
WORKER_ID       = os.environ.get("WORKER_ID") or f"phone-{uuid.uuid4().hex[:6]}"
POLL_MIN        = float(os.environ.get("POLL_MIN", "8"))
POLL_MAX        = float(os.environ.get("POLL_MAX", "30"))
SIPHON_TIMEOUT  = int(os.environ.get("SIPHON_TIMEOUT", "180"))
OUT_DIR         = os.environ.get("DM_OUT_DIR", "/tmp/dm-worker")

if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit("FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required")

H = {
    "apikey":        SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type":  "application/json",
}

_RUNNING = True

def _shutdown(signum, _frame):
    global _RUNNING
    _RUNNING = False
    log(f"signal {signum} received; finishing in-flight job then exiting")

signal.signal(signal.SIGTERM, _shutdown)
signal.signal(signal.SIGINT, _shutdown)


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {WORKER_ID} {msg}", flush=True)


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") or "report"


def jitter_sleep() -> None:
    time.sleep(random.uniform(POLL_MIN, POLL_MAX))


# ---------------------------------------------------------------------------
# SUPABASE CALLS
# ---------------------------------------------------------------------------

def claim() -> dict | None:
    """Claim one pending job. Returns the row dict or None."""
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/claim_next_job",
        headers=H,
        json={"p_worker_id": WORKER_ID},
        timeout=20,
    )
    r.raise_for_status()
    body = r.json()
    # PostgREST returns {} or {"id": null, ...} when the function returned NULL row
    if not body or not body.get("id"):
        return None
    return body


def post_report(request_id: str, keyword: str, payload: dict) -> None:
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/reports",
        headers={**H, "Prefer": "return=minimal"},
        json={"request_id": request_id, "keyword": keyword, "payload": payload},
        timeout=30,
    )
    r.raise_for_status()


def delete_job(job_id: str) -> None:
    r = requests.delete(
        f"{SUPABASE_URL}/rest/v1/query_queue?id=eq.{job_id}",
        headers={**H, "Prefer": "return=minimal"},
        timeout=20,
    )
    r.raise_for_status()


def mark_failed(job_id: str) -> None:
    """If we can't requeue, surface 'failed' so the sweeper can clean it up."""
    try:
        r = requests.patch(
            f"{SUPABASE_URL}/rest/v1/query_queue?id=eq.{job_id}",
            headers={**H, "Prefer": "return=minimal"},
            json={"status": "failed"},
            timeout=20,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        log(f"mark_failed network error id={job_id}: {e!r}")


# ---------------------------------------------------------------------------
# SIPHON SUBPROCESS
# ---------------------------------------------------------------------------

def run_siphon(keyword: str) -> dict:
    """Invoke siphon.py and return its parsed JSON output."""
    os.makedirs(OUT_DIR, exist_ok=True)
    proc = subprocess.run(
        ["python3", SIPHON_PATH, keyword, "--out", OUT_DIR],
        capture_output=True,
        text=True,
        timeout=SIPHON_TIMEOUT,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"siphon exit {proc.returncode}: {proc.stderr[:400] or proc.stdout[:400]}"
        )
    path = os.path.join(OUT_DIR, f"report_{slugify(keyword)}.json")
    if not os.path.exists(path):
        raise RuntimeError(f"siphon completed but output missing: {path}")
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    # housekeeping — don't accumulate JSON files on the device
    try:
        os.remove(path)
    except OSError:
        pass
    return payload


# ---------------------------------------------------------------------------
# MAIN LOOP
# ---------------------------------------------------------------------------

def loop() -> None:
    log(f"online; siphon={SIPHON_PATH}; poll {POLL_MIN}-{POLL_MAX}s")
    while _RUNNING:
        jitter_sleep()
        if not _RUNNING:
            break

        # 1. Claim
        try:
            job = claim()
        except requests.RequestException as e:
            log(f"claim error: {e!r}; backing off")
            time.sleep(random.uniform(15, 30))
            continue
        if not job:
            continue

        job_id     = job["id"]
        request_id = job["request_id"]
        keyword    = job["keyword"]
        log(f"claimed {job_id[:8]} keyword={keyword!r}")

        # 2. Run siphon
        t0 = time.time()
        try:
            payload = run_siphon(keyword)
        except subprocess.TimeoutExpired:
            log(f"siphon TIMEOUT id={job_id[:8]} after {SIPHON_TIMEOUT}s")
            mark_failed(job_id)
            continue
        except Exception as e:
            log(f"siphon FAIL id={job_id[:8]}: {e!r}")
            mark_failed(job_id)
            continue
        dur = time.time() - t0

        # 3. Publish + cleanup
        try:
            post_report(request_id, keyword, payload)
            delete_job(job_id)
            log(
                f"done {job_id[:8]} drift={payload.get('drift')} "
                f"conf={payload.get('confidence')} t={dur:.1f}s"
            )
        except requests.RequestException as e:
            # Don't mark failed — leave it as 'processing' so the sweeper
            # requeues it after 5 minutes. Avoids losing work on transient
            # network blips.
            log(f"publish error id={job_id[:8]}: {e!r}; sweeper will retry")

    log("loop exited cleanly")


if __name__ == "__main__":
    try:
        loop()
    except KeyboardInterrupt:
        log("KeyboardInterrupt")
    sys.exit(0)
