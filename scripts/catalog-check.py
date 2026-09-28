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

4. A MODEL THE PHONE'S ENGINE CANNOT READ. Nemotron 3 Nano 4B shipped because
   this check only asked whether the engine lists its model type; it does, and
   its reader still rejected the file after a 2 GB download. Every row's real
   config.json is now handed to the exact engine revision the app pins
   (scripts/engine-check), which builds the model the way the app does.

5. A ROW THE APPS ALREADY OUT THERE CANNOT READ. Builds before 28 decode rows
   with Swift's synthesized decoder, which requires maker, blurb, gb, vision and
   video; one row without them rejected the WHOLE list on every phone.
"""
import json, re, os, subprocess, sys, tempfile, urllib.request, concurrent.futures as cf
from pathlib import Path

UA = {"User-Agent": "radiant-catalog/2"}
CATALOG = Path('apps/ios/catalog.json')
RESOLVED = Path('apps/ios/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved')
# ⚠️ THE OLDEST ENGINE STILL ON PHONES. Rows in `models` reach every build,
# including App Store 1.1 (build 21), whose engine is this revision — so they
# must load there too, not only on the engine the next build pins. Raise it
# only when no supported build carries an older engine.
ENGINE_FLOOR = {'location': 'https://github.com/ml-explore/mlx-swift-lm.git',
                'state': {'revision': '14414441fa44f45eee35a61e9fa0bab577cf9734'}}
OLD_APP_KEYS = ('id', 'name', 'maker', 'blurb', 'gb', 'repo', 'vision', 'video')

def get(url, raw=False, tries=3):
    for k in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45)
            return r.read().decode() if raw else json.load(r)
        except Exception:
            pass
    return None

CONFIGS = {}   # row id -> config.json text, for the engine check

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

    raw = get(f"https://huggingface.co/{repo}/raw/main/config.json", raw=True)
    if raw is None:
        return out + [f"{row['id']}: no config.json at {repo}"]
    CONFIGS[row['id']] = raw
    try:
        cfg = json.loads(raw)
    except ValueError:
        return out + [f"{row['id']}: config.json is not JSON ({repo})"]
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

def engine_check(rows, lm=None, label=''):
    """Build scripts/engine-check against an engine revision (default: the app's pin); run every config."""
    pins = {p['identity']: p for p in json.loads(RESOLVED.read_text())['pins']}
    lm, core = lm or pins['mlx-swift-lm'], pins['mlx-swift']
    core_dep = (f'exact: "{core["state"]["version"]}"' if core['state'].get('version')
                else f'revision: "{core["state"]["revision"]}"')
    work = Path.home() / 'Library/Caches/radiant-engine-check' / lm['state']['revision'][:12]
    (work / 'Sources').mkdir(parents=True, exist_ok=True)
    (work / 'Package.swift').write_text(f"""// swift-tools-version:5.9
// Generated by scripts/catalog-check.py from the app's Package.resolved.
import PackageDescription
let package = Package(name: "engine-check", platforms: [.macOS(.v14)],
  dependencies: [
    .package(url: "{lm['location']}", revision: "{lm['state']['revision']}"),
    .package(url: "{core['location']}", {core_dep}),
  ],
  targets: [.executableTarget(name: "engine-check", dependencies: [
    .product(name: "MLXLLM", package: "mlx-swift-lm"),
    .product(name: "MLXVLM", package: "mlx-swift-lm")], path: "Sources")])
""")
    (work / 'Sources/main.swift').write_text(Path('scripts/engine-check/main.swift').read_text())
    print(f"  building the engine check against {lm['location'].split('github.com/')[-1]} @ {lm['state']['revision'][:7]}…")
    b = subprocess.run(['swift', 'build'], cwd=work, capture_output=True, text=True)
    # Xcode's Metal compiler lives on a disk image macOS remounts under a new
    # random folder; the cached build plan keeps the old path and every .metal
    # file fails with "unable to spawn process". Drop the plan, build once more.
    if b.returncode != 0 and 'MetalToolchain' in b.stdout + b.stderr:
        subprocess.run(['rm', '-rf', str(work / '.build/out/Intermediates.noindex/XCBuildData')])
        b = subprocess.run(['swift', 'build'], cwd=work, capture_output=True, text=True)
    if b.returncode != 0:
        tail = ' '.join((b.stderr or b.stdout).strip().splitlines()[-3:])[:300]
        return [f"engine check could not be built, so nothing was verified: {tail}"]
    tmp = Path(tempfile.mkdtemp(prefix='radiant-cfg-'))
    args = []
    for r in rows:
        if r['id'] in CONFIGS:
            f = tmp / (r['id'].replace('/', '_') + '.json')
            f.write_text(CONFIGS[r['id']])
            args.append(f"{r['id']}={f}")
    run = subprocess.run([str(work / '.build/debug/engine-check'), *args], capture_output=True, text=True)
    lines = run.stdout.splitlines()
    fails = [l[5:] for l in lines if l.startswith('FAIL ')]
    passed = sum(1 for l in lines if l.startswith('OK '))
    if run.returncode != 0 or passed + len(fails) != len(args):
        return [f"engine check crashed after {passed + len(fails)} of {len(args)} models: {(run.stderr or '').strip()[-300:]}"]
    return [f"{f.split(':', 1)[0]}: the{label} phone engine cannot load it — {f.split(':', 1)[-1].strip()[:220]}" for f in fails]

def main():
    doc = json.loads(CATALOG.read_text())
    models = doc['models']
    rows = models + (doc.get('gated') or [])
    print(f"  checking {len(rows)} rows against HuggingFace…")
    problems = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for res in ex.map(check, rows):
            problems += res
    for r in models:
        missing = [k for k in OLD_APP_KEYS if k not in r]
        if missing:
            problems.append(f"{r['id']}: missing {', '.join(missing)} — apps before build 28 would reject the whole list")
    for r in doc.get('gated') or []:
        if not isinstance(r.get('minBuild'), int):
            problems.append(f"{r['id']}: in `gated` without a minBuild")
    problems += engine_check(rows)
    problems += engine_check(models, ENGINE_FLOOR, label=' OLDEST (App Store 1.1)')
    for p in problems:
        print('  FAIL ' + p)
    if problems:
        sys.exit(f"\n  {len(problems)} problem(s) — NOT safe to publish")
    print(f"  {len(rows)}/{len(rows)} rows verified · sizes, quantization, repos, older apps, and the phone's engine all check out")

main()
