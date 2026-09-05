#!/usr/bin/env python3
"""
⚠️ THIS SCRIPT HAS NEVER RUN. Do not reach for it before a submission.

It needs two files that have never existed in this repo — archs.txt (line 3)
and cands.json (line 27) — so it has raised FileNotFoundError since e3595d1,
which is the very commit that introduced it while fixing "Gemma 4 could not
load: the weights were quantized, the config did not say so".

AGENTS.md used to say "before any future submission, run scripts/catalog-verify.py".
Anyone who obeyed that got a traceback. The guard against the defect that forced
build 4 was, in practice, absent.

THE GATE THAT ACTUALLY WORKS IS `npm run catalog:check` (scripts/catalog-check.py).
It runs, it is wired into `npm run catalog:publish`, and it performs the check
that matters: bytes-per-parameter against an undeclared `quantization` in
config.json — exactly the Gemma 4 failure — plus repo existence and declared
size. It verified 49/49 rows the last time it ran.

What this file would have added beyond that is one thing: whether MLX implements
a model's architecture, tested against the archs.txt list. That list was never
checked in and cannot be reconstructed honestly, so this is kept as a record of
intent rather than repaired into something that looks trustworthy and is not.

Kept, not deleted, because the shape of the arch check is worth having if
someone rebuilds it. Retained below, unreachable.
"""
import sys
print(__doc__)
print("Refusing to run. Use: npm run catalog:check")
sys.exit(2)

# ---------------------------------------------------------------------------
# original, non-functional
# import json,urllib.request,re,time,concurrent.futures as cf
# UA={"User-Agent":"radiant-catalog/1"}
# ARCHS=set(open('archs.txt').read().split())
# def get(u,raw=False,tries=4):
#     for k in range(tries):
#         try:
#             r=urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=60)
#             return r.read().decode() if raw else json.load(r)
#         except Exception: time.sleep(1.2*(k+1))
#     return None
# CAND=json.load(open('cands.json'))
# def check(row):
#     mid=row["repo"]
#     meta=get(f"https://huggingface.co/api/models/{mid}?blobs=true")
#     if not meta: return {**row,"err":"no repo"}
#     gb=round(sum(f.get("size") or 0 for f in meta.get("siblings") or [])/1e9,2)
#     cfg=get(f"https://huggingface.co/{mid}/raw/main/config.json") or {}
#     arch=cfg.get("model_type") or (cfg.get("text_config") or {}).get("model_type")
#     tc=get(f"https://huggingface.co/{mid}/raw/main/tokenizer_config.json") or {}
#     eos=tc.get("eos_token"); eos=eos.get("content") if isinstance(eos,dict) else eos
#     tmpl=tc.get("chat_template") or get(f"https://huggingface.co/{mid}/raw/main/chat_template.jinja",raw=True) or ""
#     if isinstance(tmpl,list): tmpl=json.dumps(tmpl)
#     toks=set(re.findall(r'<\|[a-z_]{2,24}\|>|<end_of_turn>|<turn\|>|\[\|[a-z]+\|\]|</s>|<\|im_end\|>', tmpl))
#     # the stop token is the template's turn-end when it differs from eos_token
#     stop=None
#     for t in ("<turn|>","<end_of_turn>","<|end|>","<|im_end|>","<|eot_id|>"):
#         if t in toks and t!=eos: stop=t; break
#     # ⚠️ A REPO CAN NAME AN ARCHITECTURE MLX IMPLEMENTS AND STILL NOT LOAD.
#     # MLX builds the model from config.json, so if the weights are quantized but
#     # config.json declares no `quantization`, it constructs a dense model and the
#     # tensor shapes disagree — MLX raises "mismatched parameters" only once the
#     # user has finished downloading gigabytes. Google's gemma-4-*-qat-mobile
#     # repos are exactly this, and both shipped in the catalogue.
#     # Detected by weight density: under ~1.2 bytes per parameter the file IS
#     # quantized, so config.json must say so.
#     quant = cfg.get("quantization") or (cfg.get("text_config") or {}).get("quantization")
#     params = ((meta.get("safetensors") or {}).get("total")) or 0
#     bpp = (gb*1e9/params) if params else None
#     packed_but_undeclared = bool(bpp and bpp < 1.2 and not quant)
#     return {**row,"gb":gb,"arch":arch,"eos":eos,"stop":stop,
#             "quant":bool(quant),"bpp":round(bpp,2) if bpp else None,
#             "ok":(arch in ARCHS) and not packed_but_undeclared,
#             "err":"quantized weights but config.json declares no quantization -> MLX will fail with 'mismatched parameters'" if packed_but_undeclared else None,
#             "dl":meta.get("downloads",0)}
# out=[]
# with cf.ThreadPoolExecutor(10) as ex:
#     for r in ex.map(check,CAND): out.append(r)
# json.dump(out,open('verified.json','w'),indent=1)
# bad=[r for r in out if r.get("err") or not r.get("ok")]
# print(f"verified {len(out)}, problems {len(bad)}")
# for r in bad: print("  BAD",r["repo"],r.get("err") or r.get("arch"))
# for r in sorted(out,key=lambda r:(r["maker"],r.get("gb",0))):
#     if r.get("err") or not r.get("ok"): continue
#     print(f'{r["maker"]:<14} {r.get("gb"):>5} {r["arch"]:<12} stop={str(r["stop"]):<16} {r["repo"]}')
#