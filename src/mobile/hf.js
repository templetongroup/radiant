/**
 * Searching Hugging Face for a model, and saying whether it will run here.
 *
 * Tony: "add a separate section in the models page that lets you search
 * hugging face for models and lets you know if they will run on your phone
 * or not and then let you download and install the model into radiant."
 *
 * Three questions, answered from the repo itself before a byte is downloaded,
 * the same way scripts/catalog-check.py qualifies the built-in list:
 *   1. Is it an architecture the app's MLX build can load? (model_type in
 *      config.json against the registry the app links — SUPPORTED below.)
 *   2. Are the weights what config.json says? A repo whose safetensors are
 *      packed 4-bit while config declares no quantization builds a dense
 *      model, the shapes disagree, and the user gets "mismatched parameters"
 *      — after downloading 3.5 GB. That shipped once (Gemma 4, v1.0 build 2).
 *   3. Will it fit this device's memory? (fit.js, the same verdicts the
 *      catalogue rows get.)
 *
 * ⚠️ THE LIST IS OPEN, AND NOTHING IS FILTERED OUT OF IT. This search shipped
 * with a regex that hid repos whose name or tags said uncensored / abliterated
 * / NSFW — added defensively, to keep the App Store age-rating answers (which
 * were written when the model list was closed and mainstream) from going
 * stale. That was the wrong call and it was not mine to make. Tony: "why did
 * you add a filter like that at all. I would want people to be able to
 * download and use uncensored models." Radiant's whole proposition is open
 * models on hardware you own; a word filter that hides models from the owner
 * of the device contradicts it, was never a content review, and hid
 * legitimate models while missing anything named differently.
 *
 * The App Store answer is to declare the app accurately for an open list —
 * which is what the closest shipped peer (Locally AI, 12+) does — not to
 * cripple the feature. The rating questionnaire must be re-answered on that
 * basis before the next submission; see docs/APP_STORE_LISTING.md.
 */

// model_type values the linked mlx-swift-lm (checkout 14414441, 2026-08-22)
// can build — the keys of LLMModelFactory and VLMModelFactory. Regenerate from
// the checkout when the package moves; a stale list is a wrong "won't run".
export const SUPPORTED = new Set([
  'acereason', 'afmoe', 'apertus', 'baichuan_m1', 'bailing_moe', 'bitnet', 'cohere', 'deepseek_v2', 'deepseek_v3', 'ernie4_5',
  'exaone4', 'falcon_h1', 'gemma', 'gemma2', 'gemma3', 'gemma3_text', 'gemma3n', 'gemma4', 'gemma4_text', 'gemma4_unified',
  'glm4', 'glm4_moe', 'glm4_moe_lite', 'gpt_oss', 'granite', 'granitemoehybrid', 'helium', 'hunyuan_v1_dense', 'internlm2',
  'jamba', 'lfm2', 'lfm2_moe', 'lille-130m', 'llama', 'mamba2', 'mimo', 'mimo_v2_flash', 'minicpm', 'minimax', 'mistral',
  'mistral3', 'mixtral', 'nanbeige', 'nanochat', 'nemotron_h', 'nemotron_labs_diffusion', 'olmo2', 'olmo3', 'olmoe', 'openelm',
  'phi', 'phi3', 'phimoe', 'qwen2', 'qwen3', 'qwen3_5', 'qwen3_5_moe', 'qwen3_5_text', 'qwen3_moe', 'qwen3_next', 'smollm3',
  'starcoder2',
  // vision
  'fastvlm', 'glm_ocr', 'idefics3', 'lfm2-vl', 'lfm2_vl', 'llava_qwen2', 'muse_glimmer', 'paligemma', 'pixtral', 'qwen2_5_vl',
  'qwen2_vl', 'qwen3_vl', 'qwen3_vl_moe', 'smolvlm'
])
export const VISION_TYPES = new Set(['fastvlm', 'glm_ocr', 'idefics3', 'lfm2-vl', 'lfm2_vl', 'llava_qwen2', 'muse_glimmer', 'paligemma', 'pixtral', 'qwen2_5_vl', 'qwen2_vl', 'qwen3_vl', 'qwen3_vl_moe', 'smolvlm', 'gemma3', 'gemma4', 'gemma4_unified'])

const UA = { accept: 'application/json' }

/** Search results: MLX repos that look like chat models, most downloaded first. */
export async function searchModels (query, { limit = 25, signal } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=mlx&sort=downloads&direction=-1&limit=${limit * 2}`
  const res = await fetch(url, { headers: UA, signal })
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}.`)
  const rows = await res.json()
  return rows
    .filter(r => r && r.id)
    .filter(r => !/embed|rerank|lora|adapter/i.test(r.id))
    .slice(0, limit)
    .map(r => ({ repo: r.id, owner: r.id.split('/')[0], name: r.id.split('/').pop(), downloads: r.downloads || 0, likes: r.likes || 0, updated: r.lastModified || null }))
}

/** What the repo actually is: size, architecture, quantization — and the verdict. */
export async function inspectRepo (repo, { signal } = {}) {
  const [meta, cfg] = await Promise.all([
    fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, { headers: UA, signal }).then(r => r.ok ? r.json() : Promise.reject(new Error(`Hugging Face answered ${r.status} for ${repo}.`))),
    fetch(`https://huggingface.co/${repo}/raw/main/config.json`, { signal }).then(r => r.ok ? r.json() : null).catch(() => null)
  ])
  const siblings = meta.siblings || []
  const weights = siblings.filter(s => /\.safetensors$/.test(s.rfilename))
  const bytes = weights.reduce((n, s) => n + (s.size || 0), 0)
  const gb = bytes / 1e9
  const modelType = cfg?.model_type || cfg?.text_config?.model_type || null
  const quant = cfg?.quantization || cfg?.quantization_config || null
  const params = paramCount(meta, cfg)
  const bytesPerParam = params ? bytes / params : null
  return { repo, gb, bytes, modelType, quantized: Boolean(quant), bits: quant?.bits ?? null, params, bytesPerParam, vision: modelType ? VISION_TYPES.has(modelType) : false, hasWeights: weights.length > 0, draft: (cfg?.architectures || []).some(a => /draft/i.test(a)) }
}

function paramCount (meta, cfg) {
  const st = meta.safetensors?.total
  if (typeof st === 'number' && st > 0) return st
  return null
}

/**
 * The verdict, in the order a person needs it: can the app load it at all,
 * will it load correctly, will it fit. `fit` is fit.js's verdict for the size.
 */
export function qualify (info, fit) {
  if (!info.hasWeights) return { ok: false, tone: 'negative', label: 'No weights', why: 'This repo has no safetensors files — it is not a model Radiant can download.' }
  if (!info.modelType) return { ok: false, tone: 'negative', label: 'Unknown type', why: 'No config.json with a model type — Radiant cannot tell what this is.' }
  // A draft model (config says qwen3, architecture says DFlash2DraftModel) only
  // speeds up a bigger model; its weights do not fit the chat loader.
  if (info.draft) return { ok: false, tone: 'negative', label: 'Won’t run', why: 'This is a draft model — a helper that speeds up a bigger model. It cannot hold a conversation on its own.' }
  if (!SUPPORTED.has(info.modelType)) return { ok: false, tone: 'negative', label: 'Won’t run', why: `Radiant’s engine has no loader for “${info.modelType}” models yet.` }
  // ⚠️ THE GEMMA 4 DEFECT: packed weights, no declaration. Under ~1.2 bytes per
  // parameter with no quantization in config.json means 4-bit weights that MLX
  // will try to read as 16-bit — "mismatched parameters" after the download.
  if (!info.quantized && info.bytesPerParam != null && info.bytesPerParam < 1.2) return { ok: false, tone: 'negative', label: 'Won’t load', why: 'The weights look quantized but config.json does not say so; the download would fail to load. Pick a repo from mlx-community with the same model instead.' }
  if (!info.quantized && info.gb > 8) return { ok: false, tone: 'negative', label: 'Too big', why: `${info.gb.toFixed(1)} GB of unquantized weights — look for a 4-bit version.` }
  if (fit === 'no') return { ok: false, tone: 'negative', label: 'Won’t fit', why: `${info.gb.toFixed(1)} GB needs more memory than this device can give one app.` }
  if (fit === 'tight') return { ok: true, tone: 'caution', label: 'Runs tight', why: `${info.gb.toFixed(1)} GB fits, but close to the limit — expect it to be slow.` }
  return { ok: true, tone: 'positive', label: 'Runs well', why: `${info.gb.toFixed(1)} GB, ${info.bits ? info.bits + '-bit' : 'quantized'}, ${info.modelType}.` }
}

/** A catalogue row for a repo the person chose, in the shape the app's store takes. */
export function customRow (info, meta = {}) {
  const name = meta.name || info.repo.split('/').pop().replace(/[-_]/g, ' ').replace(/\b(mlx|4bit|8bit|bf16)\b/gi, '').replace(/\s+/g, ' ').trim()
  return {
    id: 'hf-' + info.repo.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    maker: info.repo.split('/')[0],
    blurb: `From Hugging Face — ${info.repo}.`,
    gb: Math.round(info.gb * 100) / 100,
    repo: info.repo,
    vision: Boolean(info.vision),
    stop: /gemma/i.test(info.modelType || '') ? '<end_of_turn>' : (/phi/i.test(info.modelType || '') ? '<|end|>' : null)
  }
}
