#!/usr/bin/env python3
"""Hourly caption backfill worker for Trinity Sermons.

Picks up to --batch videos missing captions, fetches via YouTube track URLs
+ direct curl (bypasses yt-dlp's throttled download path), parses, and POSTs
to the token-protected /admin/ingest endpoint (which triggers the OpenAI
profile backfill automatically).

Idempotent: skips videos already in .caps/. Exits 42 on YouTube 429 so the
scheduler can retry later.

Usage: python3 caption-backfill.py [--batch 8]
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.expanduser("~/workspace/trinity-sermons")
HIDDEN = os.path.join(REPO, "hidden_files")
CAPS = os.path.join(REPO, ".caps")
os.makedirs(CAPS, exist_ok=True)
YDL_CANDIDATES = [os.path.expanduser("~/.local/bin/yt-dlp"), "yt-dlp"]
YDL = next((p for p in YDL_CANDIDATES if os.path.exists(p)), "yt-dlp")
BASE = "https://trinity-sermons-production.up.railway.app"


def get_token() -> str:
    r = subprocess.run(
        ["railway", "variable", "list", "--json", "-s", "trinity-sermons",
         "-p", "55943659-d96e-43a9-a01c-171156296e89", "-e", "production"],
        capture_output=True, text=True, timeout=60,
        env={**os.environ, "PATH": os.path.expanduser("~/.railway/bin") + ":" + os.environ.get("PATH", "")})
    return json.loads(r.stdout)["INGEST_ADMIN_TOKEN"]


def meta():
    rows = {}
    for line in open(os.path.join(HIDDEN, "trinity_meta.tsv")):
        p = line.rstrip("\n").split("|", 3)
        if len(p) == 4:
            rows[p[0]] = {"date": p[1], "duration": p[2], "title": p[3]}
    return rows


def track_urls(vid):
    r = subprocess.run(
        [YDL, "--impersonate", "chrome", "--skip-download",
         "--extractor-args", "youtube:player_client=android",
         "--print", "%(subtitles)s|%(automatic_captions)s",
         f"https://www.youtube.com/watch?v={vid}"],
        capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return None, r.stderr[-200:]
    line = r.stdout.strip().split("\n")[-1]
    parts = line.split("|", 1)
    out = {}
    for idx, field in enumerate(parts):
        if not field or field == "NA":
            continue
        for m in re.finditer(r"'en(?:-orig)?':.*?\{'ext': '(vtt|json3)', 'url': '([^']+)'", field):
            ext, url = m.groups()
            url = url.encode().decode("unicode_escape")
            src = "youtube_manual" if idx == 0 else "youtube_auto"
            if src not in out:
                out[src] = (ext, url)
            break
    return out, ""


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read(), ""
    except urllib.error.HTTPError as e:
        return None, f"http {e.code}"
    except Exception as e:
        return None, str(e)[:100]


def parse_json3(body):
    d = json.loads(body)
    segs = []
    for ev in d.get("events", []):
        t = "".join(s.get("utf8", "") for s in ev.get("segs", "")).strip()
        t = re.sub(r"\s+", " ", t).strip()
        if t:
            segs.append({"start": ev.get("tStartMs", 0) / 1000,
                         "end": (ev.get("tStartMs", 0) + ev.get("dDurationMs", 0)) / 1000,
                         "text": t})
    return dedupe(segs)


def parse_vtt(body):
    text = body.decode("utf-8", errors="replace")
    cue_re = re.compile(r"(\d+:)?\d+:\d+\.\d+\s*-->\s*(\d+:)?\d+:\d+\.\d+")

    def ts(t):
        p = t.strip().split(":")
        return float(p[-1]) + (int(p[-2]) * 60 if len(p) > 1 else 0)

    segs, s, e = [], 0.0, 0.0
    for line in text.split("\n"):
        line = line.strip()
        if not line or line == "WEBVTT":
            continue
        m = cue_re.match(line)
        if m:
            a, b = line.split("-->")
            s, e = ts(a), ts(b)
            continue
        if line.startswith("NOTE") or "-->" in line:
            continue
        t = re.sub(r"<[^>]+>", "", line).strip()
        if t:
            segs.append({"start": s, "end": e, "text": t})
    return dedupe(segs)


def dedupe(segs):
    out = []
    for sg in segs:
        if not out or out[-1]["text"] != sg["text"]:
            out.append(sg)
    return out


NAME_RE = re.compile(r"^(Pastor |Dr\. )?([A-Z][a-z'.]+)( & | and )?([A-Z][a-z'.]+)?( [A-Z][a-z'.]+)?$")


def preacher(title):
    tail = title.split("|")[-1].strip()
    if tail.lower().startswith("trinity new york"):
        return None
    return tail if NAME_RE.match(tail) else None


def post(path, data, token, method="POST"):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(data).encode() if data else None,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main():
    batch = int(sys.argv[sys.argv.index("--batch") + 1]) if "--batch" in sys.argv else 8
    no_post = "--no-post" in sys.argv
    ids = [l.strip() for l in open(os.path.join(HIDDEN, "keep_ids.txt")) if l.strip()]
    have = sum(1 for v in ids if os.path.exists(os.path.join(CAPS, v + ".json")))
    todo = [v for v in ids if not os.path.exists(os.path.join(CAPS, v + ".json"))][:batch]
    print(f"have {have}/{len(ids)} captioned, {len(todo)} to try this run", flush=True)
    if not todo:
        print("all captions fetched", flush=True)
        return
    md = meta()
    token = None if no_post else get_token()
    new_items = []
    for i, vid in enumerate(todo, 1):
        tracks, err = track_urls(vid)
        if tracks is None:
            print(f"[{i}/{len(todo)}] {vid} META-FAIL", flush=True)
            if "429" in err or "bot" in err.lower():
                print("STOPPING (rate limited)", flush=True)
                sys.exit(42)
            time.sleep(10)
            continue
        if not tracks:
            json.dump({"none": True}, open(os.path.join(CAPS, vid + ".json"), "w"))
            print(f"[{i}/{len(todo)}] {vid} NO-CAPTIONS", flush=True)
            time.sleep(8)
            continue
        src = "youtube_manual" if "youtube_manual" in tracks else "youtube_auto"
        ext, url = tracks[src]
        body, derr = download(url)
        if body is None:
            print(f"[{i}/{len(todo)}] {vid} DL-FAIL {derr}", flush=True)
            if "429" in derr:
                print("STOPPING (rate limited)", flush=True)
                sys.exit(42)
            time.sleep(10)
            continue
        try:
            segs = parse_vtt(body) if ext == "vtt" else parse_json3(body)
        except Exception as ex:
            print(f"[{i}/{len(todo)}] {vid} PARSE-FAIL {ex}", flush=True)
            time.sleep(8)
            continue
        plain = " ".join(s["text"] for s in segs)
        m = md.get(vid, {})
        if len(plain) < 500:
            json.dump({"none": True}, open(os.path.join(CAPS, vid + ".json"), "w"))
            print(f"[{i}/{len(todo)}] {vid} TOO-SHORT", flush=True)
        else:
            rec = {"source": src, "segments": segs}
            json.dump(rec, open(os.path.join(CAPS, vid + ".json"), "w"))
            date = m.get("date", "")
            new_items.append({
                "youtubeVideoId": vid,
                "title": m.get("title", vid),
                "publishedAt": f"{date[:4]}-{date[4:6]}-{date[6:8]}" if len(date) == 8 else "2023-01-01",
                "preacher": preacher(m.get("title", "")),
                "durationSeconds": int(float(m.get("duration", 0) or 0)),
                "series": None, "source": src, "segments": segs, "plainText": plain})
            print(f"[{i}/{len(todo)}] {vid} OK ({src}, {len(plain)} chars)", flush=True)
        time.sleep(12)
    if new_items and not no_post:
        resp = post("/admin/ingest", {"videos": new_items}, token)
        print(f"posted {len(new_items)}: {resp}", flush=True)
    if no_post:
        print(f"fetched {len(new_items)} new captions (not posted)", flush=True)
        return
    # report backfill status
    st = post("/admin/ingest-status", None, token, method="GET")
    print(f"backfill: running={st['running']} done={st['done']} failed={st['failed']} gen={st['corpusGeneration']}", flush=True)


if __name__ == "__main__":
    main()
