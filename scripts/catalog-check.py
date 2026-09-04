#!/usr/bin/env python3
"""
Checks apps/ios/catalog.json against the real repos, BEFORE it is published.

⚠️ PUBLISHING REMOVED THE SAFETY NET THAT APP REVIEW USED TO PROVIDE. A bad row in
the Swift array took a week to reach anybody and could be caught in between. A bad
row here reaches every installed phone at the next launch. So the check that used
to be advisory is now the gate.

Three failures, each of which has actually happened or would be invisible:

1. QUANTIZED WEIGHTS, UNDECLARED. The repo's weights are packed 4-bit while its
   config.json declares no `quantization`. MLX builds a dense model, the tensor
   shapes disagree, and the user gets `mismatched parameters` — after downloading
   several GB. This is exactly what shipped in v1.0 build 2 for Gemma 4.

2. A SIZE THAT IS NOT THE REPO'S SIZE. The download progress bar divides by `gb`.
   Wrong by 20% and the bar reads 120% or stops at 80%. Download progress has
   broken in production on this app four times.

3. A REPO THAT IS NOT THERE. A 404 is a model that downloads nothing, forever.
"""
import json, re, sys, urllib.request, concurrent.futures as cf
from pathlib import Path

UA = {"User-Agent": "radiant-catalog/2"}
CATALOG = Path('apps/ios/catalog.json')

def get(url, raw=False, tries=3):
    for k in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45)
            return r.read().decode() if raw else json.load(r)
        except Exception:
            pass
    return None

def check(row):
    repo, out = row['repo'], []
    meta = get(f"https://huggingface.co/api/models/{repo}?blobs=true")
    if not meta:
        return [f"{row['id']}: repo not reachable — {repo}"]

    measured = sum(f.get('size') or 0 for f in (meta.get('siblings') or []))
    if measured == 0:
        out.append(f"{row['id']}: no blob sizes from HuggingFace for {repo}")
    else:
        gb = measured / 1e9
        drift = abs(gb - row['gb']) / gb
        if drift > 0.10:
            out.append(f"{row['id']}: size is {gb:.2f} GB but the catalogue says {row['gb']:.2f} "
                       f"({drift * 100:.0f}% off — the progress bar divides by this)")

    cfg = get(f"https://huggingface.co/{repo}/raw/main/config.json") or {}
    quant = cfg.get('quantization') or (cfg.get('text_config') or {}).get('quantization')
    params = None
    for key in ('total_params', 'num_parameters'):
        if isinstance(meta.get('safetensors'), dict):
            params = meta['safetensors'].get('total') or params
    if not quant and params and measured:
        bpp = measured / params
        if bpp < 1.2:
            out.append(f"{row['id']}: {bpp:.2f} bytes/param with no `quantization` in config.json — "
                       f"MLX will build a dense model and fail with mismatched parameters ({repo})")
    return out

def main():
    doc = json.loads(CATALOG.read_text())
    rows = doc['models']
    print(f"  checking {len(rows)} rows against HuggingFace…")
    problems = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for res in ex.map(check, rows):
            problems += res
    for p in problems:
        print('  FAIL ' + p)
    if problems:
        sys.exit(f"\n  {len(problems)} problem(s) — NOT safe to publish")
    print(f"  {len(rows)}/{len(rows)} rows verified · sizes, quantization and repos all check out")

main()
