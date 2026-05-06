# DriftMetrics // Fleet Deployment Reference

`v0.1.0` — Acurast & self-hosted Android compute · zero-dollar deployment

> ## ⚠ NOT THE ACTIVE DEPLOYMENT PATH
>
> This document describes **Path C (self-hosted Termux/Ubuntu)**, which is
> **incompatible with the Acurast Root Image** that runs on the active fleet.
> The Acurast Root Image is locked to the TEE runtime; it does not expose
> Termux, a Linux userland, or Python.
>
> **For the current production fleet, follow `acurast/DEPLOY.md` instead.**
> That uses Path B (Acurast Cloud deployer) with the TypeScript-ported
> engine (`acurast/siphon.ts` + `acurast/job.ts`).
>
> This file is preserved for two reasons:
>   1. Local dev — you can install Termux on a personal device to test
>      `siphon.py` directly without involving the TEE.
>   2. Reference — if you ever add consumer Android phones to a side fleet
>      (e.g., a Pixel running unmodified Android 14), the Path C steps
>      still apply to those devices.
>
> Do NOT follow this doc to deploy onto Acurast Root Image phones. It will
> not work.

---

## 0 // READ THIS FIRST — what "Acurast fleet" actually means

There are **three different things** people call an Acurast fleet, and only some of them will run `siphon.py`. Pick before you build.

| Path | What it is | Runs Python? | Cost | Effort |
|---|---|---|---|---|
| **A. Acurast Processor (earner)** | Install the Acurast Android app. Your phones earn $ACU by executing jobs from the public network in a TEE sandbox. | **No.** Sandbox is Deno/TypeScript, network-restricted. | Free (you earn) | Trivial |
| **B. Acurast Cloud (deployer)** | You publish jobs to the Acurast network. Other people's processors run them. | **No.** Same Deno/TEE constraint. Job code must be JS/TS. | Pay $ACU per job | Medium — rewrite required |
| **C. Self-hosted Android fleet** | You own/control the phones. Termux + Ubuntu chroot. Acurast app may or may not be installed alongside. | **Yes.** Full Linux. | Free if devices already in hand | Highest |

**For DriftMetrics today: Path C is the only one that runs `siphon.py` unchanged.** Bing/Yahoo/DDG scraping needs unrestricted outbound HTTP, full `requests` + `bs4` stack, and a long-running shell. Acurast's TEE forbids all three.

If you also want to earn passively on the same hardware, install the Acurast Processor app on the phones — it can coexist with your Termux scraping workload. Covered briefly at the end.

> If the goal turns into "publish a public DriftMetrics scanner that anyone can pay $ACU to run," you'd port the engine to Deno and follow Path B. That's a different project.

---

## 1 // RECOMMENDED PATH: Termux + Ubuntu chroot per device

### Why a chroot and not raw Termux

Raw Termux is fine for `requests + bs4 + lxml`. But:

- `lxml` wheels on Termux's `aarch64` are not always available — sometimes triggers a 4-minute compile.
- Cron-style scheduling on Termux requires the `termux-job-scheduler` shim and is finicky on Android 13+.
- A real Ubuntu rootfs gives you `cron`, `systemd-less timers`, predictable `pip` behavior, OpenSSH server, and identical paths to your dev machine.

The 30-second decision: **Termux for bootstrap + SSH server, Ubuntu chroot via `proot-distro` for the actual workload.**

### Per-device prerequisites

- Android 7+ phone with developer mode on (not strictly required but useful)
- 2 GB+ free storage
- Wi-Fi or cellular data
- One-time physical access to install Termux + run setup

---

## 2 // PER-DEVICE SETUP — first run

### 2.1 Install Termux

Install **from F-Droid**, not from Google Play. The Play Store version is years out of date and will break on `pkg update`.

- F-Droid: https://f-droid.org/packages/com.termux/
- Termux Boot (auto-start on reboot): https://f-droid.org/packages/com.termux.boot/

Open Termux, then:

```bash
pkg update -y && pkg upgrade -y
pkg install -y openssh proot-distro git curl wget nano termux-api
termux-setup-storage   # accept the Android permission dialog
```

### 2.2 Lock in SSH

```bash
# set a password so you can SSH in
passwd

# start sshd on port 8022 (Termux can't bind <1024 without root)
sshd

# pin your public key so you can stop typing the password
mkdir -p ~/.ssh && chmod 700 ~/.ssh
# from your dev machine, copy your pubkey into ~/.ssh/authorized_keys
```

From your dev machine:

```bash
# replace IP with the phone's LAN IP from `ifconfig` inside Termux
ssh -p 8022 u0_a123@192.168.1.40
```

> The username is whatever Termux shows in its prompt — typically `u0_a###`. Run `whoami` inside Termux to grab it.

### 2.3 Auto-start sshd on boot

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-sshd <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sshd
EOF
chmod +x ~/.termux/boot/start-sshd
```

The Termux:Boot app must be installed and opened once for this to fire. `termux-wake-lock` keeps the device from sleeping the network stack — important for long scrape runs.

### 2.4 Install Ubuntu chroot

```bash
proot-distro install ubuntu
proot-distro login ubuntu
# you are now inside Ubuntu
```

Inside Ubuntu:

```bash
apt update && apt install -y python3 python3-pip python3-venv \
    cron rsync openssh-client ca-certificates curl
exit  # back to Termux
```

### 2.5 Drop in the script

Inside Termux:

```bash
mkdir -p ~/storage/shared/driftmetrics
cd ~/storage/shared/driftmetrics
# either git clone, or scp from dev machine:
#   scp -P 8022 siphon.py u0_a123@<phone-ip>:storage/shared/driftmetrics/
```

Then enter Ubuntu and bind to the same path:

```bash
proot-distro login ubuntu --bind ~/storage/shared/driftmetrics:/opt/dm
cd /opt/dm
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python3 siphon.py "ai coding assistants" --out ./reports --verbose
```

If that ran and produced `reports/report_ai-coding-assistants.json`, the device is live.

---

## 3 // FLEET ORCHESTRATION — driving N phones from your dev machine

The pattern: a manifest of phones + a parallel runner. Don't reinvent — `parallel-ssh` (`pssh`) is enough for fleets under ~50, after that move to Ansible.

### 3.1 Hosts file

```ini
# ~/dm-fleet/hosts.txt
192.168.1.40:8022
192.168.1.41:8022
192.168.1.42:8022
```

For phones outside your LAN (cellular / different Wi-Fi), use a Tailscale or ZeroTier mesh — both have free tiers, both run on Termux, and both give you stable hostnames per device. Setup on phone:

```bash
pkg install tailscale     # Termux package, not the Android app
tailscale up
```

After that you can SSH to `phone-04.tailnet.ts.net:8022` and skip LAN-IP juggling.

### 3.2 The wrapper script (run inside the chroot)

Create `/opt/dm/run.sh` on each phone:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/dm
source .venv/bin/activate

KEYWORD="${1:?keyword required}"
SLOT="${2:-A}"

# stagger by slot so devices don't all hit Bing simultaneously
SLEEP=$(( (RANDOM % 90) + 30 ))
sleep "$SLEEP"

mkdir -p reports
python3 siphon.py "$KEYWORD" --out ./reports --verbose >> "logs/${SLOT}.log" 2>&1
```

```bash
chmod +x /opt/dm/run.sh
```

### 3.3 Fleet-wide invocation

From your dev machine:

```bash
# install pssh once
brew install pssh   # or: apt install pssh

parallel-ssh \
  -h ~/dm-fleet/hosts.txt \
  -i -t 600 -p 16 \
  "proot-distro login ubuntu --bind ~/storage/shared/driftmetrics:/opt/dm -- /opt/dm/run.sh 'best running shoes' A"
```

Run with `-p 16` (16 phones in parallel) but keep the `sleep` in `run.sh` — that's the actual rate limiter.

### 3.4 Per-device keyword sharding

Don't send the same keyword to every phone — that's how IP blocks happen, fast. Shard by keyword:

```bash
# keywords.txt — one per line
# fleet-shard.sh
mapfile -t KEYWORDS < keywords.txt
mapfile -t HOSTS < ~/dm-fleet/hosts.txt
for i in "${!KEYWORDS[@]}"; do
  HOST="${HOSTS[$((i % ${#HOSTS[@]}))]}"
  KW="${KEYWORDS[$i]}"
  ssh -p 8022 -o StrictHostKeyChecking=accept-new "u0_a123@${HOST%:*}" \
    "proot-distro login ubuntu --bind ~/storage/shared/driftmetrics:/opt/dm -- /opt/dm/run.sh '$KW' A" &
done
wait
```

Each phone scans a different keyword. Different keywords from different IPs is dramatically less detectable than the same keyword across many IPs.

---

## 4 // JOB SCHEDULING — making it run on its own

You have two options. Use cron inside the chroot — it's the path of least resistance.

### 4.1 Cron inside Ubuntu (recommended)

```bash
proot-distro login ubuntu --bind ~/storage/shared/driftmetrics:/opt/dm
service cron start
crontab -e
```

Add:

```cron
# DriftMetrics — scan the rotation every 6 hours
0 */6 * * * /opt/dm/run.sh "$(shuf -n1 /opt/dm/keywords.txt)" cron >> /opt/dm/logs/cron.log 2>&1
```

`shuf -n1` picks one keyword at random per tick — gives you natural spread without coding it up.

To make `service cron start` survive reboots, add it to your Termux boot script:

```bash
# ~/.termux/boot/start-sshd  (extend it)
proot-distro login ubuntu -- service cron start
```

### 4.2 termux-job-scheduler (Android-native)

Only use this if cron-in-chroot won't start for some Android-vendor reason (Xiaomi MIUI is the usual offender — it kills background processes aggressively).

```bash
termux-job-scheduler \
  --period-ms 21600000 \
  --persisted true \
  --network unmetered \
  --script ~/storage/shared/driftmetrics/run.sh
```

`unmetered` only runs on Wi-Fi. Use `any` if your fleet has cellular plans you want to use.

### 4.3 Battery / vendor whack-a-mole

Android OEMs love killing background apps. Per device, do all of this:

- Settings → Battery → Battery optimization → Termux + Termux:Boot → **Don't optimize**
- Settings → Apps → Termux → Battery → **Unrestricted**
- MIUI / OneUI / ColorOS: lock Termux in the recent-apps tray (long-press → padlock)
- Disable "adaptive battery" globally if available
- Plug the device in if the deployment is permanent — battery degradation on always-on phones is real

---

## 5 // OUTPUT COLLECTION — getting JSON off the fleet

Two patterns. Pick one, don't mix.

### 5.1 PULL — central rsync

Cron on your dev machine pulls every hour:

```bash
# ~/dm-fleet/pull.sh
while read host; do
  HOST="${host%:*}"; PORT="${host#*:}"
  rsync -az -e "ssh -p $PORT" \
    "u0_a123@$HOST:storage/shared/driftmetrics/reports/" \
    "$HOME/dm-data/$HOST/"
done < ~/dm-fleet/hosts.txt
```

Simple, reliable, no auth tokens to manage. Phones don't need to know anything about your central server.

### 5.2 PUSH — webhook from each phone

Add to `run.sh` after the python invocation:

```bash
LATEST=$(ls -t reports/*.json | head -1)
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "X-DM-Device: $(hostname)" \
  --data-binary "@$LATEST" \
  "$DM_INGEST_URL"
```

Useful when the phones are on cellular behind CGNAT and you can't reach them inbound. Set `DM_INGEST_URL` per-device in `/opt/dm/.env`. Pair with a small Cloudflare Worker or a `flask` endpoint on a free Fly.io / Railway tier as the ingest sink.

> Don't put real auth secrets in `.env` on a phone you don't physically control. Use a per-device HMAC token signed by your central server, rotate weekly, and reject unsigned posts at the ingest.

---

## 6 // ANTI-BLOCK HYGIENE

The single biggest reason fleets stop producing data is detection. The script already rotates UAs and Accept-Language; the rest is operational.

| Lever | What to do | Why |
|---|---|---|
| **Timing** | Stagger 30–90s within a job, ≥5min between jobs per device | Pattern detection on Bing/Yahoo keys on inter-request intervals |
| **IP diversity** | Mix Wi-Fi and cellular; don't put 20 phones on the same SSID | Same /24 = same fingerprint |
| **Keyword spread** | Shard keywords across phones (§3.4) | Same keyword from many IPs = bot signature |
| **Session reuse** | The `requests.Session` in `Siphon` keeps cookies — leave it | Looks more like a returning browser |
| **Concurrency cap** | Never run `siphon.py` twice on one device simultaneously | Trivial fingerprint |
| **Backoff respect** | The script already retries 429/503 with jitter — don't override | Aggressive retry = faster ban |
| **Mobile UA** | If you go cellular-only, swap `USER_AGENTS` for a mobile UA pool | Cellular IP + desktop UA = mismatch flag |

Bing has been the first to block in past runs of similar tools. Yahoo is more permissive. DDG html is the most permissive of the three. If you see Bing blocks dominate, drop Bing entirely and run Yahoo as primary, DDG as both baseline and enclosure-fallback. The `confidence` field will reflect the degraded source.

---

## 7 // MONITORING — knowing your fleet is alive

Minimal viable: each device pings a heartbeat URL once a minute. Anything not seen in 10 minutes is "down."

On each phone, in cron:

```cron
* * * * * curl -fsS "https://heartbeat.example.com/$(hostname)" >/dev/null 2>&1
```

Free options for the receiver:
- [healthchecks.io](https://healthchecks.io) — free for 20 checks, sends email on missed pings
- A 30-line Cloudflare Worker that writes to KV

What to track per device, beyond "is it alive":
- Last successful scrape timestamp
- Block rate (count of `enclosure_rows == 0` in the last N runs)
- Average `confidence` across the last hour
- Battery level (`termux-battery-status` returns JSON)

A weekly digest of those four numbers is enough to spot a phone that's gone soft (battery dying, IP burned, OEM started killing the chroot) before it silently rots for a month.

---

## 8 // ACURAST PROCESSOR — passive earning on the same hardware

If you also want $ACU income from the phones while they're scraping for you:

1. Install **Acurast Processor** from Google Play or F-Droid: https://acurast.com/processor
2. Open the app once, link it to a wallet (the docs walk through this — it changes more than once a year, so trust their flow over my description).
3. The app runs in a TEE sandbox. It does **not** see your Termux workload, and your Termux work doesn't see its jobs. They cohabitate.
4. Battery and thermal: both workloads will compete. If you see your scrape `confidence` dropping after installing the Processor, your phones are thermally throttling. Either dedicate phones to one workload or accept reduced throughput on both.

For deploying *your* code to *other people's* Acurast processors (Path B from §0):
- Job code must be Deno/TypeScript, no native deps.
- Outbound network is allow-listed; you declare the endpoints in the job manifest.
- Console: https://console.acurast.com
- Docs: https://docs.acurast.com

If you want to port DriftMetrics to a public Acurast job, the rewrite is non-trivial — `BeautifulSoup` becomes `deno_dom`, `requests` becomes `fetch`, the pure-Python TF-IDF translates cleanly. Budget a day. Worth it only if you want others to be able to pay $ACU to run scans, not for your own internal use.

> My knowledge of Acurast specifics is current as of early 2025 — the Processor app, console, and CLI all change. Verify against `docs.acurast.com` before doing anything irreversible.

---

## 9 // TROUBLESHOOTING

**`pip install lxml` hangs for minutes**
Building from source on aarch64. Wait it out (one-time), or skip lxml and let the script fall back to `html.parser`:
```bash
pip install requests beautifulsoup4
```

**`sshd` exits immediately with no error**
You forgot `passwd` or `~/.ssh/authorized_keys` is misconfigured. Tail `~/.termux/var/log/auth.log` if the package is installed; otherwise run `sshd -d -p 8022` to see verbose output.

**Cron in chroot doesn't fire**
`service cron status` first. If it's not running, `service cron start`. If it starts but never fires, check that your crontab is for the *root* user inside the chroot (which is what `proot-distro login` drops you into) and that there's a trailing newline.

**Termux gets killed after the screen turns off**
You skipped `termux-wake-lock` or didn't whitelist battery optimization. Both, every device.

**Bing returns HTML but zero `li.b_algo`**
Soft-block. Selectors may also have changed. Curl one of the URLs from the phone and `grep -c b_algo` — if zero, your IP is on a list. Switch to Yahoo as primary or wait 24h. If zero across many IPs, Bing changed selectors and `_bing_results` needs a patch.

**Phone reboots and nothing comes back up**
Termux:Boot was never opened (it must be opened *once* manually after install). Open it. From then on, reboots auto-recover.

**`proot-distro login` is slow on every job tick**
Yes. That's the proot overhead. If it's measurably hurting throughput, switch to running cron *inside* the chroot session that's already up, kept alive by `tmux` or `screen` from the boot script. Adds complexity; only worth it past ~30 jobs/hour/device.

---

## 10 // ONE-PAGE DEVICE SETUP CHECKLIST

```
[ ] Termux installed from F-Droid
[ ] Termux:Boot installed AND opened once
[ ] pkg update && pkg upgrade
[ ] pkg install openssh proot-distro git curl termux-api
[ ] passwd set
[ ] ~/.ssh/authorized_keys populated
[ ] sshd auto-start in ~/.termux/boot/
[ ] termux-wake-lock in same boot script
[ ] Battery optimization disabled for Termux + Termux:Boot
[ ] proot-distro install ubuntu
[ ] python3 + pip + cron inside chroot
[ ] siphon.py + requirements.txt copied to ~/storage/shared/driftmetrics/
[ ] pip install -r requirements.txt inside chroot
[ ] One successful test run: python3 siphon.py "test query"
[ ] /opt/dm/run.sh wrapper in place
[ ] crontab entry installed
[ ] Heartbeat curl in crontab
[ ] Phone added to ~/dm-fleet/hosts.txt on dev machine
[ ] Tailscale/ZeroTier joined if device is off-LAN
```

Run that for the first phone; copy the SD card / `tar` the Termux home dir for subsequent phones to skip 90% of the setup.
