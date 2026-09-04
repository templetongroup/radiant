#!/usr/bin/env python3
"""
Turns the compiled-in iOS catalogue into the JSON the app fetches at runtime.

⚠️ THE SWIFT ARRAY STAYS THE SOURCE OF TRUTH. It is what ships in the binary and
what the app falls back to when it is offline, when the fetch fails, or when the
JSON is malformed — so the two must never be written independently. This reads the
array and emits the JSON, which means the published catalogue cannot drift from the
one Apple reviewed.

⚠️ HALF THE ROWS DO NOT NAME THEIR REPO. They use LLMRegistry constants, which are
ModelConfigurations defined inside mlx-swift-lm — id plus extraEOSTokens. A remote
catalogue can only carry strings, so each constant is resolved against
LLMModelFactory.swift. If a constant cannot be resolved this REFUSES to emit rather
than shipping a row with no repo, because a row with no repo is a model the phone
downloads nothing for.
"""
import json, re, sys, subprocess
from datetime import datetime, timezone
from pathlib import Path

SWIFT = Path('apps/ios/ios/App/App/plugins/LocalModels.swift')
OUT = Path('apps/ios/catalog.json')

def registry_file():
    hits = subprocess.run(
        ['find', str(Path.home() / 'Library/Developer/Xcode/DerivedData'),
         '-name', 'LLMModelFactory.swift'],
        capture_output=True, text=True).stdout.split()
    if not hits:
        sys.exit('  LLMModelFactory.swift not found — build the iOS app once so SPM checks it out')
    return Path(hits[0])

def registry_map():
    """constant name -> (repo id, first extra EOS token or None)"""
    src = registry_file().read_text()
    out = {}
    for m in re.finditer(
            r'static public let (\w+)\s*=\s*ModelConfiguration\((.*?)\n\s*\)', src, re.S):
        name, body = m.group(1), m.group(2)
        rid = re.search(r'id:\s*"([^"]+)"', body)
        eos = re.search(r'extraEOSTokens:\s*\[([^\]]*)\]', body)
        tok = None
        if eos:
            toks = re.findall(r'"([^"]+)"', eos.group(1))
            tok = toks[0] if toks else None
        if rid:
            out[name] = (rid.group(1), tok)
    return out

def catalog_block(src):
    # ⚠️ START AFTER THE "=", NOT AT THE FIRST "[". The declaration is
    # `private let catalog: [Entry] = [` — the first bracket belongs to the TYPE
    # annotation, so scanning from there matched "[Entry]" and returned a 7-character
    # block with no rows in it.
    decl = 'private let catalog: [Entry] = ['
    i = src.index(decl)
    j = i + len(decl) - 1          # the opening bracket of the array literal
    depth = 0
    for k in range(j, len(src)):
        if src[k] == '[': depth += 1
        elif src[k] == ']':
            depth -= 1
            if depth == 0:
                return src[j:k + 1]
    sys.exit('  could not find the end of the catalog array')

def main():
    src = SWIFT.read_text()
    reg = registry_map()
    block = catalog_block(src)
    rows, missing = [], []
    # ⚠️ SPLIT ON Entry(, THEN READ FIELDS — one big regex over a multi-line row is
    # how the first version silently produced ZERO models: it matched nothing and
    # cheerfully wrote an empty catalogue, which is the worst possible output
    # because the app would have accepted it.
    chunks = block.split('Entry(')[1:]
    for chunk in chunks:
        def field(pat):
            m = re.search(pat, chunk, re.S)
            return m.group(1) if m else None
        rid   = field(r'id:\s*"([^"]+)"')
        name  = field(r'name:\s*"([^"]+)"')
        maker = field(r'maker:\s*"([^"]+)"')
        blurb = field(r'blurb:\s*"([^"]*)"')
        gb    = field(r'gb:\s*([0-9.]+)')
        # ⚠️ TO END OF LINE, NOT TO END OF STRING. The first version terminated the
        # config capture on `$`, which without re.M means the end of the whole file —
        # so it matched only the LAST row and 15 of 49 models were dropped. They were
        # dropped SILENTLY, and the exporter reported "34 models" as if that were the
        # answer.
        cfg   = field(r'config:\s*([^\n]+)')
        if not (rid and name and gb and cfg):
            missing.append((rid or '?', 'could not parse: ' + ' '.join(chunk.split())[:60]))
            continue
        vision = bool(re.search(r'vision:\s*true', chunk))
        video  = bool(re.search(r'video:\s*true', chunk))
        repo, stop = None, None
        raw = re.search(r'rxRepo\("([^"]+)"(?:\s*,\s*stop:\s*"([^"]+)")?', cfg)
        if raw:
            repo, stop = raw.group(1), raw.group(2)
        else:
            const = re.search(r'LLMRegistry\.(\w+)', cfg)
            if const and const.group(1) in reg:
                repo, stop = reg[const.group(1)]
            elif const:
                missing.append((rid, const.group(1)))
                continue
        if not repo:
            missing.append((rid, cfg.strip()[:50]))
            continue
        row = {'id': rid, 'name': name, 'maker': maker or '', 'blurb': blurb or '',
               'gb': float(gb), 'repo': repo}
        if stop: row['stop'] = stop
        if vision: row['vision'] = True
        if video: row['video'] = True
        rows.append(row)

    # ⚠️ AN EMPTY CATALOGUE IS A BUG, NEVER AN ANSWER.
    # ⚠️ EVERY ROW OR NONE. A partial catalogue is worse than no catalogue: the app
    # would replace its complete built-in list with a shorter published one and the
    # missing models would simply disappear from the picker.
    if len(rows) + len(missing) != len(chunks):
        sys.exit(f'  parsed {len(rows)} + {len(missing)} but found {len(chunks)} Entry rows — the parser is losing some')
    if not rows:
        sys.exit('  parsed zero models — the Swift array format changed; fix the parser')

    if missing:
        for rid, why in missing:
            print(f'  UNRESOLVED  {rid}  ({why})')
        sys.exit(f'  {len(missing)} row(s) have no repo id — refusing to emit a catalogue with holes in it')

    doc = {'schema': 1,
           'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'models': rows}
    OUT.write_text(json.dumps(doc, indent=2) + '\n')
    print(f'  {OUT} — {len(rows)} models, {OUT.stat().st_size // 1024} KB')

main()
