// RWKV-Instant (sm72e25, leak-free w64) recurrent memory model in pure TypeScript Float32Array.
// Direct port of JSchoreels/anki-rwkv `reference/small_model_recurrent.py` + `weights_io.py` +
// the leak-free 92-feature builder from INTEGRATION.md sections 6.4–6.9.
//
// Zero Python or native runtime needed: one review step runs in <0.5ms on CPU.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fsrsScheduler, type Depth, type Grade, type State, type Unit } from "@myelin/core";

export interface RwkvStreamSpec {
  name: "card_id" | "deck_id" | "note_id" | "preset_id" | "user_id";
  n_layers: number;
  n_heads: number;
  head_size: number;
  channel_mixer_dim: number;
  channel_mixer_stripped_layers: number[];
}

export interface RwkvSpec {
  d_model: number;
  card_features: number;
  zero_features: number[];
  layer_steps: [number, number][];
  streams: RwkvStreamSpec[];
  constants: {
    layer_norm_eps: number;
    group_norm_eps: number;
    normalize_eps: number;
    softplus_threshold: number;
    prob_clamp: number;
    power_clamp: number;
    power_s_eps: number;
    min_elapsed_seconds: number;
  };
}

interface Tensor {
  shape: number[];
  data: Float32Array;
}

interface LayerState {
  shift: Float32Array;
  S: Float32Array; // [H * K * K]
  cshift?: Float32Array;
}

export type RwkvStore = Map<number, Map<number, LayerState>>[];

export interface RwkvHeads {
  w_logits: Float32Array;
  s_raw: Float32Array;
  d_raw: Float32Array;
  p_logits: Float32Array;
}

export type ScheduleKind = "first" | "normal" | "relearn" | "lapse" | "override";

export interface RwkvUnitScore {
  unit_id: string;
  /** Instant probability of recall right now (1 - P(again)). */
  p_imm: number;
  /** Probability distribution [again, hard, good, easy] if asked right now. */
  p_rating: [number, number, number, number];
  /** Estimated ms from now until p_curve drops below target (null if never reviewed). */
  next_in_ms: number | null;
  reviews: number;
  /** Effective scheduled interval (effective_due_at - scheduling_event_at) from the latest scheduling decision. */
  scheduled_interval_ms?: number | null;
  schedule_kind?: ScheduleKind;
}

const F32_MAGIC = "ARWKVWEIGHTS1";
const I8_MAGIC = "ARWKVWEIGHTS8PC1";
const DAY_MS = 86_400_000;
const CYCLE_PERIODS = [3, 7, 30, 100, 365, 3650, 36500] as const;

export function readRwkvWeights(path: string): Map<string, Tensor> {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;

  const magic16 = buf.subarray(0, 16).toString("ascii");
  let int8 = false;
  if (magic16.startsWith(I8_MAGIC)) {
    pos = I8_MAGIC.length;
    int8 = true;
  } else if (magic16.startsWith(F32_MAGIC)) {
    pos = F32_MAGIC.length;
    int8 = false;
  } else {
    throw new Error(`rwkv: unknown weight container magic in ${path}`);
  }

  const count = view.getUint32(pos, true);
  pos += 4;
  const tensors = new Map<string, Tensor>();

  for (let t = 0; t < count; t++) {
    const nameLen = view.getUint16(pos, true);
    pos += 2;
    const name = buf.subarray(pos, pos + nameLen).toString("utf8");
    pos += nameLen;
    const kind = int8 ? view.getUint8(pos++) : 0;
    const rank = view.getUint8(pos++);
    const shape: number[] = [];
    let size = 1;
    for (let r = 0; r < rank; r++) {
      const d = view.getUint32(pos, true);
      pos += 4;
      shape.push(d);
      size *= d;
    }
    if (kind === 1) {
      const rows = shape[0] ?? 1;
      const cols = Math.floor(size / rows);
      const scales = new Float32Array(rows);
      for (let i = 0; i < rows; i++) {
        scales[i] = view.getFloat32(pos, true);
        pos += 4;
      }
      const data = new Float32Array(size);
      for (let r = 0; r < rows; r++) {
        const sc = scales[r]!;
        const off = r * cols;
        for (let c = 0; c < cols; c++) {
          data[off + c] = view.getInt8(pos++) * sc;
        }
      }
      tensors.set(name, { shape, data });
    } else {
      const data = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = view.getFloat32(pos, true);
        pos += 4;
      }
      tensors.set(name, { shape, data });
    }
  }
  if (pos !== buf.byteLength) {
    throw new Error(`rwkv: ${buf.byteLength - pos} trailing bytes in ${path}`);
  }
  return tensors;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const softplus = (x: number, threshold: number) => (x > threshold ? x : Math.log1p(Math.exp(Math.min(x, threshold))));
const lerpVal = (a: number, b: number, w: number) => (Math.abs(w) < 0.5 ? a + w * (b - a) : b - (b - a) * (1 - w));

function softmax(x: Float32Array): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i]! > max) max = x[i]!;
  const out = new Float32Array(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.exp(x[i]! - max);
    out[i] = v;
    sum += v;
  }
  for (let i = 0; i < x.length; i++) out[i] = out[i]! / sum;
  return out;
}

export class RwkvRecurrentModel {
  constructor(
    private readonly w: Map<string, Tensor>,
    readonly spec: RwkvSpec,
  ) {}

  private get(name: string): Tensor {
    const t = this.w.get(name);
    if (!t) throw new Error(`rwkv: missing tensor ${name}`);
    return t;
  }

  private linear(x: Float32Array, prefix: string): Float32Array {
    const wt = this.get(`${prefix}.weight`);
    const outDim = wt.shape[0]!;
    const inDim = wt.shape[1]!;
    const wData = wt.data;
    const bData = this.w.get(`${prefix}.bias`)?.data;
    const y = new Float32Array(outDim);
    for (let o = 0; o < outDim; o++) {
      let sum = bData ? bData[o]! : 0;
      const row = o * inDim;
      for (let i = 0; i < inDim; i++) sum += x[i]! * wData[row + i]!;
      y[o] = sum;
    }
    return y;
  }

  private linearRaw(x: Float32Array, weightName: string, biasName: string): Float32Array {
    const wt = this.get(weightName);
    const bt = this.get(biasName);
    const outDim = wt.shape[0]!;
    const inDim = wt.shape[1]!;
    const y = new Float32Array(outDim);
    for (let o = 0; o < outDim; o++) {
      let sum = bt.data[o]!;
      const row = o * inDim;
      for (let i = 0; i < inDim; i++) sum += x[i]! * wt.data[row + i]!;
      y[o] = sum;
    }
    return y;
  }

  private layerNorm(x: Float32Array, prefix: string): Float32Array {
    const n = x.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i]!;
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const d = x[i]! - mean;
      variance += d * d;
    }
    variance /= n;
    const inv = 1 / Math.sqrt(variance + this.spec.constants.layer_norm_eps);
    const w = this.get(`${prefix}.weight`).data;
    const b = this.get(`${prefix}.bias`).data;
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = (x[i]! - mean) * inv * w[i]! + b[i]!;
    return y;
  }

  private groupNorm(x: Float32Array, prefix: string, groups: number): Float32Array {
    const n = x.length;
    const gs = n / groups;
    const eps = this.spec.constants.group_norm_eps;
    const w = this.get(`${prefix}.weight`).data;
    const b = this.get(`${prefix}.bias`).data;
    const y = new Float32Array(n);
    for (let g = 0; g < groups; g++) {
      const off = g * gs;
      let mean = 0;
      for (let i = 0; i < gs; i++) mean += x[off + i]!;
      mean /= gs;
      let variance = 0;
      for (let i = 0; i < gs; i++) {
        const d = x[off + i]! - mean;
        variance += d * d;
      }
      variance /= gs;
      const inv = 1 / Math.sqrt(variance + eps);
      for (let i = 0; i < gs; i++) y[off + i] = (x[off + i]! - mean) * inv * w[off + i]! + b[off + i]!;
    }
    return y;
  }

  private timeMixer(p: string, layer: number, H: number, x: Float32Array, v0: Float32Array | null, state: LayerState | undefined): { x: Float32Array; v0: Float32Array; state: LayerState } {
    const C = x.length;
    const K = C / H;
    const xl = this.layerNorm(x, `${p}.layer_norm`);
    const xs = state ? state.shift : xl;
    const S = state ? state.S : new Float32Array(H * K * K);
    const lerp = this.get(`${p}.rkvdag_lerp`).data;

    const rIn = new Float32Array(C);
    const kIn = new Float32Array(C);
    const vIn = new Float32Array(C);
    const dIn = new Float32Array(C);
    const aIn = new Float32Array(C);
    const gIn = new Float32Array(C);
    const ksIn = new Float32Array(C);
    const vsIn = new Float32Array(C);
    for (let i = 0; i < C; i++) {
      const a0 = xl[i]!;
      const b0 = xs[i]!;
      rIn[i] = lerpVal(a0, b0, lerp[i]!);
      kIn[i] = lerpVal(a0, b0, lerp[C + i]!);
      vIn[i] = lerpVal(a0, b0, lerp[2 * C + i]!);
      dIn[i] = lerpVal(a0, b0, lerp[3 * C + i]!);
      aIn[i] = lerpVal(a0, b0, lerp[4 * C + i]!);
      gIn[i] = lerpVal(a0, b0, lerp[5 * C + i]!);
      ksIn[i] = lerpVal(a0, b0, lerp[6 * C + i]!);
      vsIn[i] = lerpVal(a0, b0, lerp[7 * C + i]!);
    }

    const r = this.linear(rIn, `${p}.W_r`);
    const k = this.linear(kIn, `${p}.W_k`);
    const kScaleRaw = this.linear(ksIn, `${p}.k_scale_linear`);
    const vScaleRaw = this.linear(vsIn, `${p}.v_scale_linear`);
    const kScale = new Float32Array(H);
    const vScale = new Float32Array(H);
    for (let h = 0; h < H; h++) {
      kScale[h] = sigmoid(kScaleRaw[h]!);
      vScale[h] = sigmoid(vScaleRaw[h]!);
    }

    let v = this.linear(vIn, `${p}.W_v`);
    let nextV0: Float32Array;
    if (layer === 0) {
      nextV0 = v;
    } else {
      nextV0 = v0!;
      const vLora = this.linear(this.linear(vIn, `${p}.v_lora_simple.A`), `${p}.v_lora_simple.B_and_lamb`);
      const vMixed = new Float32Array(C);
      for (let i = 0; i < C; i++) vMixed[i] = lerpVal(v[i]!, nextV0[i]!, sigmoid(vLora[i]!));
      v = vMixed;
    }

    const aRaw = this.linear(this.linear(aIn, `${p}.a_lora_simple.A`), `${p}.a_lora_simple.B_and_lamb`);
    const a = new Float32Array(C);
    for (let i = 0; i < C; i++) a[i] = sigmoid(aRaw[i]!);

    const gMid = this.linear(gIn, `${p}.lora_A_g`);
    for (let i = 0; i < gMid.length; i++) gMid[i] = sigmoid(gMid[i]!);
    const g = this.linear(gMid, `${p}.lora_B_g`);

    const dMid = this.linear(dIn, `${p}.d_lora_mlp.A`);
    for (let i = 0; i < dMid.length; i++) dMid[i] = Math.tanh(dMid[i]!);
    const dRaw = this.linear(dMid, `${p}.d_lora_mlp.B_and_lamb`);
    const wDecay = new Float32Array(C);
    const spT = this.spec.constants.softplus_threshold;
    for (let i = 0; i < C; i++) {
      const dd = -0.5 - softplus(-dRaw[i]!, spT);
      wDecay[i] = Math.exp(-Math.exp(dd));
    }

    const normEps = this.spec.constants.normalize_eps;
    const bonusParam = this.get(`${p}.bonus`).data;
    const SNew = new Float32Array(H * K * K);
    const outAll = new Float32Array(C);
    const bonusAll = new Float32Array(C);

    for (let h = 0; h < H; h++) {
      const hOff = h * K;
      const sOff = h * K * K;

      let kNormSq = 0;
      let vNormSq = 0;
      for (let j = 0; j < K; j++) {
        const kv = k[hOff + j]!;
        const vv = v[hOff + j]!;
        kNormSq += kv * kv;
        vNormSq += vv * vv;
      }
      const kInv = kScale[h]! / Math.max(Math.sqrt(kNormSq), normEps);
      const vInv = vScale[h]! / Math.max(Math.sqrt(vNormSq), normEps);

      const kk = new Float32Array(K);
      const vv = new Float32Array(K);
      const kb = new Float32Array(K);
      let bonusScalar = 0;
      for (let j = 0; j < K; j++) {
        const kdj = k[hOff + j]! * kInv;
        const vvj = v[hOff + j]! * vInv;
        const kbj = kdj * a[hOff + j]!;
        kk[j] = kdj;
        vv[j] = vvj;
        kb[j] = kbj;
        bonusScalar += r[hOff + j]! * bonusParam[hOff + j]! * kbj;
      }
      for (let i = 0; i < K; i++) bonusAll[hOff + i] = bonusScalar * vv[i]!;

      for (let i = 0; i < K; i++) {
        const rowOff = sOff + i * K;
        let sKk = 0;
        for (let j = 0; j < K; j++) sKk += S[rowOff + j]! * kk[j]!;
        let outI = 0;
        const vvi = vv[i]!;
        for (let j = 0; j < K; j++) {
          const val = S[rowOff + j]! * wDecay[hOff + j]! - sKk * kb[j]! + vvi * kb[j]!;
          SNew[rowOff + j] = val;
          outI += val * r[hOff + j]!;
        }
        outAll[hOff + i] = outI;
      }
    }

    const gnOut = this.groupNorm(outAll, `${p}.out_group_norm`, H);
    const gated = new Float32Array(C);
    for (let i = 0; i < C; i++) gated[i] = g[i]! * (gnOut[i]! + bonusAll[i]!);
    const proj = this.linear(gated, `${p}.W_o`);
    const xOut = new Float32Array(C);
    for (let i = 0; i < C; i++) xOut[i] = x[i]! + proj[i]!;
    return { x: xOut, v0: nextV0, state: { shift: xl, S: SNew } };
  }

  private channelMixer(p: string, x: Float32Array, shift: Float32Array | undefined): { x: Float32Array; shift: Float32Array } {
    const C = x.length;
    const xl = this.layerNorm(x, `${p}.layer_norm`);
    const xs = shift ?? xl;
    const lerpK = this.get(`${p}.lerp_k`).data;
    const kIn = new Float32Array(C);
    for (let i = 0; i < C; i++) kIn[i] = lerpVal(xl[i]!, xs[i]!, lerpK[i]!);
    const k = this.linear(kIn, `${p}.W_k`);
    for (let i = 0; i < k.length; i++) {
      const m = k[i]! > 0 ? k[i]! : 0;
      k[i] = m * m;
    }
    const v = this.linear(k, `${p}.W_v`);
    const out = new Float32Array(C);
    for (let i = 0; i < C; i++) out[i] = x[i]! + v[i]!;
    return { x: out, shift: xl };
  }

  newStore(): RwkvStore {
    return this.spec.streams.map(() => new Map());
  }

  step(features: Float32Array, ids: Record<RwkvStreamSpec["name"], number>, skip: boolean, store: RwkvStore): RwkvHeads {
    const f = new Float32Array(features);
    for (const idx of this.spec.zero_features) f[idx] = 0;

    let x = this.linear(f, "features2card.0");
    for (let i = 0; i < x.length; i++) x[i] = x[i]! * sigmoid(x[i]!);
    x = this.layerNorm(x, "features2card.2");
    x = this.linear(x, "features2card.3");
    for (let i = 0; i < x.length; i++) x[i] = x[i]! * sigmoid(x[i]!);

    const v0: (Float32Array | null)[] = this.spec.streams.map(() => null);
    const pending: { i: number; entity: number; layer: number; state: LayerState }[] = [];

    for (const [i, layer] of this.spec.layer_steps) {
      const s = this.spec.streams[i]!;
      const entity = ids[s.name];
      const old = store[i]!.get(entity)?.get(layer);
      const p = `rwkv_modules.${i}.blocks.${layer}`;
      const tm = this.timeMixer(`${p}.time_mixer`, layer, s.n_heads, x, v0[i]!, old);
      x = tm.x;
      v0[i] = tm.v0;
      const tstate = tm.state;
      if (!s.channel_mixer_stripped_layers.includes(layer)) {
        const cm = this.channelMixer(`${p}.channel_mixer`, x, old?.cshift);
        x = cm.x;
        tstate.cshift = cm.shift;
      }
      pending.push({ i, entity, layer, state: tstate });
    }

    if (!skip) {
      for (const item of pending) {
        let entityMap = store[item.i]!.get(item.entity);
        if (!entityMap) {
          entityMap = new Map();
          store[item.i]!.set(item.entity, entityMap);
        }
        entityMap.set(item.layer, item.state);
      }
    }

    const h = this.layerNorm(x, "prehead_norm");
    const hw0 = this.linear(h, "head_w.0");
    for (let i = 0; i < hw0.length; i++) if (hw0[i]! < 0) hw0[i] = 0;
    const hw = this.linear(this.layerNorm(hw0, "head_w.2"), "head_w.4");

    const hp0 = this.linear(h, "head_p.0");
    for (let i = 0; i < hp0.length; i++) if (hp0[i]! < 0) hp0[i] = 0;

    return {
      w_logits: this.linearRaw(hw, "gru_w_weight", "gru_w_bias"),
      s_raw: this.linearRaw(hw, "gru_s_weight", "gru_s_bias"),
      d_raw: this.linearRaw(hw, "gru_d_weight", "gru_d_bias"),
      p_logits: this.linear(hp0, "p_linear"),
    };
  }

  pCurve(heads: RwkvHeads, elapsedSeconds: number): number {
    const c = this.spec.constants;
    const weights = softmax(heads.w_logits);
    const t = Math.max(elapsedSeconds, c.min_elapsed_seconds);
    let r = 0;
    for (let i = 0; i < weights.length; i++) {
      const s = Math.exp(Math.max(-c.power_clamp, Math.min(c.power_clamp, heads.s_raw[i]!)));
      const d = Math.exp(Math.max(-c.power_clamp, Math.min(c.power_clamp, heads.d_raw[i]!)));
      r += weights[i]! * Math.exp(-d * Math.log1p(t / (c.power_s_eps + s)));
    }
    const eps = c.prob_clamp;
    const raw = eps + (1 - 2 * eps) * r;
    return sigmoid(Math.log(raw / (1 - raw)) + eps);
  }

  instant(heads: RwkvHeads): { p_imm: number; p_rating: [number, number, number, number] } {
    const p = softmax(heads.p_logits);
    const eps = this.spec.constants.prob_clamp;
    const pImm = Math.max(eps, Math.min(1 - eps, 1 - p[0]!));
    return { p_imm: pImm, p_rating: [p[0]!, p[1]!, p[2]!, p[3]!] };
  }
}

// --- Feature builder (INTEGRATION.md sections 6.4–6.9, leak-free) -----------------------------

const GRADE_RATING: Record<Grade, number> = { again: 1, hard: 2, good: 3, easy: 4 };
const L = (x: number) => (x === -1 ? 0 : Math.log(1 + 1e-5 + x));
const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Deterministic pseudo-random code in {-1.5, -0.5, 0.5, 1.5} for an entity string key. */
function entityCode(key: string, dim: number): Float32Array {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    // xorshift32
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h = h >>> 0;
    out[i] = (h & 3) - 1.5;
  }
  return out;
}

function stableId(map: Map<string, number>, key: string): number {
  let id = map.get(key);
  if (id === undefined) {
    id = map.size + 1;
    map.set(key, id);
  }
  return id;
}

interface CardTracker {
  firstAt: number;
  firstDayOffset: number;
  lastAt: number;
  lastTh: number;
  lastNewCardsCount: number;
  cumDays: number;
  cumSeconds: number;
  reviews: number;
  lastHeads: RwkvHeads | null;
}

function buildFeatures(params: {
  elapsedDays: number;
  cumDays: number;
  elapsedSeconds: number;
  cumSeconds: number;
  durationMs: number;
  rating: number; // 1..4 or 0 for query
  dayOffsetDiff: number;
  dayOffset: number;
  dayOffsetFirst: number;
  diffNewCards: number;
  diffReviews: number;
  cumNewCardsToday: number;
  cumReviewsToday: number;
  isQuery: boolean;
  cardCode: Float32Array;
  noteCode: Float32Array;
  deckCode: Float32Array;
  presetCode: Float32Array;
}): Float32Array {
  const f = new Float32Array(92);
  f[0] = (L(params.elapsedDays) - 1.51) / 1.62;
  f[1] = (L(params.cumDays) - 2.14) / 2.25;
  f[2] = (L(params.elapsedSeconds) - 9.96) / 5.21;
  const pElap = (2 * Math.PI * mod(params.elapsedSeconds, 86400)) / 86400;
  f[3] = Math.sin(pElap);
  f[4] = Math.cos(pElap);
  f[5] = (L(params.cumSeconds) - 10.86) / 5.8;
  const pCum = (2 * Math.PI * mod(params.cumSeconds, 86400)) / 86400;
  f[6] = Math.sin(pCum);
  f[7] = Math.cos(pCum);
  f[8] = params.isQuery ? 0 : (Math.log(10 + Math.max(0, params.durationMs)) - 8.9) / 1.07;
  if (!params.isQuery && params.rating >= 1 && params.rating <= 4) {
    f[8 + params.rating] = 1;
  }
  // 13, 14, 15: leak-free missing-ID flags are always 0.
  f[16] = Math.log(Math.log(Math.E + Math.max(0, params.dayOffsetDiff)));
  f[17] = (mod(params.dayOffset, 7) - 3) / 3;
  f[18] = (Math.log(3 + Math.max(0, params.diffNewCards)) - 2.945) / 2.011;
  f[19] = (Math.log(3 + Math.max(0, params.diffReviews)) - 4.64) / 2.59;
  f[20] = (Math.log(3 + Math.max(0, params.cumNewCardsToday)) - 2.55) / 1.41;
  f[21] = (Math.log(3 + Math.max(0, params.cumReviewsToday)) - 4.59) / 1.3;
  f[22] = 0; // zeroed by model
  f[23] = params.isQuery ? 1 : 0;

  f.set(params.cardCode, 24);
  f.set(params.noteCode, 36);
  f.set(params.deckCode, 48);
  f.set(params.presetCode, 56);

  let off = 64;
  for (const period of CYCLE_PERIODS) {
    const freq = (2 * Math.PI) / period;
    const a1 = freq * mod(params.dayOffset, period);
    const a2 = freq * mod(params.dayOffsetFirst, period);
    f[off++] = Math.sin(a1);
    f[off++] = Math.cos(a1);
    f[off++] = Math.sin(a2);
    f[off++] = Math.cos(a2);
  }
  return f;
}

/** Finds elapsed ms until p_curve drops to `target` via binary search (10m..365d). */
function estimateNextMs(model: RwkvRecurrentModel, heads: RwkvHeads, target = 0.9): number {
  let lo = 600;
  let hi = 365 * 86400;
  if (model.pCurve(heads, lo) <= target) return lo * 1000;
  if (model.pCurve(heads, hi) >= target) return hi * 1000;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (model.pCurve(heads, mid) > target) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 1000);
}

/**
 * High-level collection scorer for Myelin using RWKV-Instant (sm72e25).
 * Replays all graded probes in chronological order, then scores every active unit at `now`
 * with a non-committing Instant query row.
 */
export class RwkvInstantEngine {
  readonly name = "rwkv-sm72e25";

  constructor(readonly model: RwkvRecurrentModel) {}

  static load(dir?: string): RwkvInstantEngine | null {
    const repoModels = fileURLToPath(new URL("../../../data/models/sm72e25/sm72e25", import.meta.url));
    const candidates = [
      dir,
      process.env.MYELIN_RWKV_DIR,
      repoModels,
      join(process.cwd(), "data/models/sm72e25/sm72e25"),
      join(process.cwd(), "data/models/sm72e25"),
    ].filter((x): x is string => Boolean(x));

    for (const d of candidates) {
      const specPath = join(d, "architecture.json");
      const f32Path = join(d, "weights.f32.bin");
      const i8Path = join(d, "weights.int8.bin");
      if (!existsSync(specPath)) continue;
      const weightsPath = existsSync(f32Path) ? f32Path : existsSync(i8Path) ? i8Path : null;
      if (!weightsPath) continue;
      const spec = JSON.parse(readFileSync(specPath, "utf8")) as RwkvSpec;
      const weights = readRwkvWeights(weightsPath);
      return new RwkvInstantEngine(new RwkvRecurrentModel(weights, spec));
    }
    return null;
  }

  /** Scores every active non-observe-only unit in `state` at `now` using RWKV-Instant. */
  scoreUnits(state: State, now: number): Map<string, RwkvUnitScore> {
    const store = this.model.newStore();
    const cardIds = new Map<string, number>();
    const noteIds = new Map<string, number>();
    const deckIds = new Map<string, number>();
    const cardCodes = new Map<string, Float32Array>();
    const noteCodes = new Map<string, Float32Array>();
    const deckCodes = new Map<string, Float32Array>();
    const presetCode = entityCode("preset:default", 8);

    const codeFor = (map: Map<string, Float32Array>, key: string, dim: number) => {
      let c = map.get(key);
      if (!c) {
        c = entityCode(key, dim);
        map.set(key, c);
      }
      return c;
    };

    const noteKeyOf = (u: Unit | undefined, fallbackId: string) => (u?.rests_on.length ? `root:${u.rests_on[0]}` : `note:${fallbackId}`);
    const deckKeyOf = (u: Unit | undefined) => `deck:${u?.topic ?? "general"}`;

    // All graded production probes in chronological order across the user's whole collection
    // (recognition-only MCQ probes stay strictly out of the RWKV memory recurrence).
    const probes = Object.values(state.evidence)
      .filter((ev) => ev.source === "probe" && ev.modality !== "mcq" && ev.grade !== null)
      .sort((a, b) => a.at - b.at || a.seq - b.seq);

    const firstReviewDay = probes.length > 0 ? Math.floor(probes[0]!.at / DAY_MS) : Math.floor(now / DAY_MS);
    const trackers = new Map<string, CardTracker>();

    let th = 0;
    let totalNewCards = 0;
    let lastDayOffset = 0;
    let curDayOffset = -1;
    let newCardsToday = 0;
    let reviewsToday = 0;

    for (const ev of probes) {
      th++;
      const u = state.units[ev.unit_id];
      const dayOffset = Math.max(0, Math.floor(ev.at / DAY_MS) - firstReviewDay);
      if (dayOffset !== curDayOffset) {
        curDayOffset = dayOffset;
        newCardsToday = 0;
        reviewsToday = 0;
      }
      const tr = trackers.get(ev.unit_id);
      const isFirst = !tr;
      const elapsedSeconds = isFirst ? -1 : Math.max(0, Math.round((ev.at - tr.lastAt) / 1000));
      const elapsedDays = isFirst ? -1 : Math.max(0, Math.floor((ev.at - tr.lastAt) / DAY_MS));
      const cumSeconds = isFirst ? -1 : tr.cumSeconds + elapsedSeconds;
      const cumDays = isFirst ? -1 : tr.cumDays + elapsedDays;
      const diffNewCards = isFirst ? 0 : totalNewCards - tr.lastNewCardsCount;
      const diffReviews = isFirst ? 0 : Math.max(0, th - tr.lastTh - 1);

      if (isFirst) {
        totalNewCards++;
        newCardsToday++;
      }

      const dayOffsetDiff = th === 1 ? 0 : Math.max(0, dayOffset - lastDayOffset);
      const dayOffsetFirst = isFirst ? dayOffset : tr.firstDayOffset;

      const cardKey = `card:${ev.unit_id}`;
      const noteKey = noteKeyOf(u, ev.unit_id);
      const deckKey = deckKeyOf(u);

      // Rescale generative writing durations (50-300s) into Anki-equivalent recognition durations
      // (~2-18s) so long derivations never poison RWKV's global user/deck hidden states.
      const scaledDurationMs =
        ev.latency_ms !== null && ev.latency_ms !== undefined
          ? Math.min(18_000, Math.max(2_000, Math.round(ev.latency_ms / 5)))
          : 8000;

      const features = buildFeatures({
        elapsedDays,
        cumDays,
        elapsedSeconds,
        cumSeconds,
        durationMs: scaledDurationMs,
        rating: GRADE_RATING[ev.grade!],
        dayOffsetDiff,
        dayOffset,
        dayOffsetFirst,
        diffNewCards,
        diffReviews,
        cumNewCardsToday: newCardsToday,
        cumReviewsToday: reviewsToday,
        isQuery: false,
        cardCode: codeFor(cardCodes, cardKey, 12),
        noteCode: codeFor(noteCodes, noteKey, 12),
        deckCode: codeFor(deckCodes, deckKey, 8),
        presetCode,
      });

      const ids: Record<RwkvStreamSpec["name"], number> = {
        card_id: stableId(cardIds, cardKey),
        deck_id: stableId(deckIds, deckKey),
        note_id: stableId(noteIds, noteKey),
        preset_id: 1,
        user_id: 1,
      };

      const heads = this.model.step(features, ids, false, store);

      trackers.set(ev.unit_id, {
        firstAt: isFirst ? ev.at : tr.firstAt,
        firstDayOffset: dayOffsetFirst,
        lastAt: ev.at,
        lastTh: th,
        lastNewCardsCount: totalNewCards,
        cumDays,
        cumSeconds,
        reviews: (tr?.reviews ?? 0) + 1,
        lastHeads: heads,
      });

      reviewsToday++;
      lastDayOffset = dayOffset;
    }

    // Query every active unit at `now` with skip=true (no state mutation).
    const nowDayOffset = Math.max(0, Math.floor(now / DAY_MS) - firstReviewDay);
    const sameDay = nowDayOffset === curDayOffset;
    const qNewToday = sameDay ? newCardsToday : 0;
    const qRevToday = sameDay ? reviewsToday : 0;
    const qDayDiff = th === 0 ? 0 : Math.max(0, nowDayOffset - lastDayOffset);

    const scores = new Map<string, RwkvUnitScore>();
    for (const u of Object.values(state.units)) {
      if (u.status === "split" || u.status === "merged" || u.observe_only) continue;
      const tr = trackers.get(u.id);
      if (!tr) {
        // Never probed yet: immediately available with p_imm = 0 (untested).
        scores.set(u.id, {
          unit_id: u.id,
          p_imm: 0,
          p_rating: [0.5, 0.25, 0.2, 0.05],
          next_in_ms: 0,
          reviews: 0,
        });
        continue;
      }

      const elapsedSeconds = Math.max(1, Math.round((now - tr.lastAt) / 1000));
      const elapsedDays = Math.max(0, Math.floor((now - tr.lastAt) / DAY_MS));
      const cardKey = `card:${u.id}`;
      const noteKey = noteKeyOf(u, u.id);
      const deckKey = deckKeyOf(u);

      const qFeatures = buildFeatures({
        elapsedDays,
        cumDays: tr.cumDays + elapsedDays,
        elapsedSeconds,
        cumSeconds: tr.cumSeconds + elapsedSeconds,
        durationMs: 0,
        rating: 0,
        dayOffsetDiff: qDayDiff,
        dayOffset: nowDayOffset,
        dayOffsetFirst: tr.firstDayOffset,
        diffNewCards: totalNewCards - tr.lastNewCardsCount,
        diffReviews: Math.max(0, th - tr.lastTh),
        cumNewCardsToday: qNewToday,
        cumReviewsToday: qRevToday,
        isQuery: true,
        cardCode: codeFor(cardCodes, cardKey, 12),
        noteCode: codeFor(noteCodes, noteKey, 12),
        deckCode: codeFor(deckCodes, deckKey, 8),
        presetCode,
      });

      const ids: Record<RwkvStreamSpec["name"], number> = {
        card_id: stableId(cardIds, cardKey),
        deck_id: stableId(deckIds, deckKey),
        note_id: stableId(noteIds, noteKey),
        preset_id: 1,
        user_id: 1,
      };

      const heads = this.model.step(qFeatures, ids, true, store);
      const { p_imm, p_rating } = this.model.instant(heads);
      const intervalMs = tr.lastHeads ? estimateNextMs(this.model, tr.lastHeads, 0.9) : null;
      const nextMs = intervalMs !== null ? Math.max(0, intervalMs - Math.max(0, now - tr.lastAt)) : null;
      scores.set(u.id, {
        unit_id: u.id,
        p_imm,
        p_rating,
        next_in_ms: nextMs,
        reviews: tr.reviews,
      });
    }
    return scores;
  }
}

export interface UnitExposureStats {
  /** Number of passed (non-"again") probes recorded for this unit. */
  passes: number;
  /** Number of passed probes at the requested depth. */
  depthPasses: number;
  /** Total graded probes at the requested depth (including misses) for prompt variant rotation. */
  depthExposures: number;
  /** Distinct prompts already shown on previous probes (newest last, max 4). */
  priorPrompts: string[];
  /** Timestamp of the most recent probe (or null if never probed). */
  lastExposureAt: number | null;
  /** Elapsed days since last exposure (0 if never probed). */
  daysSinceLastExposure: number;
}

/** Summarizes a unit's demonstrated passes, prior prompts, and recency for depth promotion & transfer prompt rotation. */
export function unitExposureStats(state: State, unitId: string, depth?: Depth, now = Date.now()): UnitExposureStats {
  const u = state.units[unitId];
  if (!u) return { passes: 0, depthPasses: 0, depthExposures: 0, priorPrompts: [], lastExposureAt: null, daysSinceLastExposure: 0 };
  const probes = u.evidence
    .map((id) => state.evidence[id])
    .filter((ev) => ev !== undefined && ev.source === "probe" && ev.grade !== null)
    .sort((a, b) => a!.at - b!.at || a!.seq - b!.seq);

  let passes = 0;
  let depthPasses = 0;
  let depthExposures = 0;
  const seenPrompts = new Set<string>();
  const priorPrompts: string[] = [];
  let lastExposureAt: number | null = null;

  for (const ev of probes) {
    if (!ev) continue;
    if (ev.at > (lastExposureAt ?? 0)) lastExposureAt = ev.at;
    if (depth && ev.depth === depth) depthExposures++;
    // Recognition-only MCQ passes never increment production pass counters (nor satisfy delayed transfer).
    if (ev.grade !== "again" && ev.modality !== "mcq") {
      passes++;
      if (depth && ev.depth === depth) depthPasses++;
    }
    const p = ev.prompt?.trim();
    if (p && !seenPrompts.has(p)) {
      seenPrompts.add(p);
      priorPrompts.push(p);
    }
  }

  return {
    passes,
    depthPasses,
    depthExposures,
    priorPrompts: priorPrompts.slice(-4),
    lastExposureAt,
    daysSinceLastExposure: lastExposureAt !== null ? Math.max(0, (now - lastExposureAt) / DAY_MS) : 0,
  };
}

/** Deduplication window for downward rests_on DAG credit within the same sitting. */
const IMPLICIT_CREDIT_DEDUP_MS = 4 * 60 * 60 * 1000;
/** Short-term relearning delay after a miss or reveal (cold retrieval after working memory flushes). */
const FIRST_RELEARN_MS = 20 * 60 * 1000;
const MAX_LAPSE_RELEARN_MS = 45 * 60 * 1000;
const SAME_DAY_RELEARN_WINDOW_MS = 12 * 60 * 60 * 1000;
const REPEAT_LAPSE_GUARD_MS = 2 * 60 * 60 * 1000;
/** Pending production check delays anchored to a terminal recognition-only MCQ event. */
export const MCQ_CLEAN_DELAY_MS = 4 * 60 * 60 * 1000;
export const MCQ_SHORT_DELAY_MS = 20 * 60 * 1000;
export const MCQ_ELIGIBILITY_GAP_MS = 4 * 60 * 60 * 1000;
export const MCQ_RETRY_OVERNIGHT_CAP_MS = 14 * 60 * 60 * 1000;

export type RepModality = "direct" | "fix_bug" | "faded_skeleton" | "contrast" | "synthesis" | "mcq";

/** True when unit `u` has a pending production check after an MCQ probe (no newer direct production probe yet). */
export function hasPendingMcqProductionCheck(u: Unit, state: State): boolean {
  let lastProdAt = -1;
  let lastMcqAt = -1;
  for (const id of u.evidence) {
    const ev = state.evidence[id];
    if (!ev || ev.source !== "probe" || ev.grade === null) continue;
    if (ev.modality === "mcq") {
      if (ev.at >= lastMcqAt) lastMcqAt = ev.at;
    } else if (ev.slot !== "in_context") {
      if (ev.at >= lastProdAt) lastProdAt = ev.at;
    }
  }
  return lastMcqAt > lastProdAt;
}

const STANDALONE_MCQ_KINDS = new Set([
  "concept",
  "knowledge",
  "definition",
  "distinction",
  "pitfall",
  "mechanism",
  "result",
]);
const PRODUCTION_PRIMARY_KINDS = new Set(["move", "skill"]);

export interface McqRoleDecision {
  role: "standalone" | "preliminary" | "none";
  reason: string;
  budgetForRole: number;
}

export interface McqDecisionOptions {
  sittingSize: number;
  compact?: boolean;
  standaloneUsed: number;
  preliminaryUsed: number;
  now?: number;
}

/**
 * v2 MCQ issuance policy:
 * - Standalone competitive MCQs for discrimination/classification/boundary/diagnosis decisions
 *   (`concept`, `knowledge`, `definition`, `distinction`, `pitfall`, `mechanism`, `result`),
 *   plus bounded maintenance MCQs for `move`/`skill` after demonstrated production.
 * - Never serves two MCQs back-to-back on the same unit (always alternates back to cold production).
 * - Preliminary two-stage gates on costly `rebuild`/`use`/code/formula reps when a prerequisite or
 *   structural check saves the learner from blind flailing (first contact, post-lapse, or >=5d gap).
 * - Budgets: desktop up to 2 standalone + 1 preliminary per sitting; mobile (`compact`) up to 4 standalone + 1 preliminary.
 */
export function decideMcqRole(
  u: Unit,
  state: State,
  depth: Depth,
  productionModality: RepModality,
  opts: McqDecisionOptions,
): McqRoleDecision {
  if (u.status !== "active" || u.observe_only) {
    return { role: "none", reason: "inactive_or_observe_only", budgetForRole: 0 };
  }
  const now = opts.now ?? Date.now();
  const kind = u.kind.trim().toLowerCase();
  const sittingSize = Math.max(1, opts.sittingSize);
  const standaloneBudget = opts.compact
    ? Math.max(1, Math.min(4, Math.ceil(sittingSize / 2)))
    : Math.max(1, Math.min(2, sittingSize >= 5 ? 2 : 1));
  const preliminaryBudget = 1;

  // Never serve two MCQs in a row on the same unit — always follow an MCQ with cold production.
  if (hasPendingMcqProductionCheck(u, state)) {
    return { role: "none", reason: "pending_cold_production", budgetForRole: 0 };
  }

  const prodProbes = u.evidence
    .map((id) => state.evidence[id])
    .filter(
      (ev): ev is NonNullable<typeof ev> =>
        Boolean(ev && ev.source === "probe" && ev.modality !== "mcq" && ev.grade !== null && ev.slot !== "imported" && ev.slot !== "in_context"),
    )
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const prodPasses = prodProbes.filter((ev) => ev.grade !== "again").length;
  const lastProd = prodProbes.at(-1) ?? null;

  const hasCodeOrFormula = CODE_CUE_RE.test(u.text) || FORMULA_CUE_RE.test(u.text);
  const isDiscriminationKind = STANDALONE_MCQ_KINDS.has(kind);
  const isProdPrimaryKind = PRODUCTION_PRIMARY_KINDS.has(kind);

  const isCostlyProduction =
    depth === "rebuild" ||
    depth === "use" ||
    productionModality === "faded_skeleton" ||
    productionModality === "fix_bug" ||
    (isProdPrimaryKind && hasCodeOrFormula);

  const needsPreliminaryTriage =
    prodPasses === 0 ||
    lastProd?.grade === "again" ||
    (lastProd !== null && now - lastProd.at >= 5 * DAY_MS);

  // On desktop (or whenever it's a genuinely costly code/formula/move/skill production rep),
  // prefer a 2-stage preliminary gate before committing to a heavy derivation/coding attempt.
  const preferStandaloneOnCompact = Boolean(opts.compact && isDiscriminationKind && !hasCodeOrFormula);
  if (
    isCostlyProduction &&
    needsPreliminaryTriage &&
    !preferStandaloneOnCompact &&
    opts.preliminaryUsed < preliminaryBudget
  ) {
    return { role: "preliminary", reason: "costly_production_triage", budgetForRole: preliminaryBudget };
  }

  // Standalone competitive MCQ for conceptual/discrimination objectives, or bounded maintenance on move/skill.
  if (opts.standaloneUsed < standaloneBudget) {
    if (isDiscriminationKind) {
      const standaloneDepthOk = depth === "recall" || depth === "explain" || !hasCodeOrFormula || Boolean(opts.compact);
      if (standaloneDepthOk) {
        return { role: "standalone", reason: "discrimination_objective", budgetForRole: standaloneBudget };
      }
    }
    if (isProdPrimaryKind && prodPasses >= 1 && lastProd?.grade !== "again") {
      return { role: "standalone", reason: "bounded_maintenance", budgetForRole: standaloneBudget };
    }
  }

  // Fallback: if standalone budget is full (or not applicable) and this is a costly rep needing triage, still allow a gate.
  if (isCostlyProduction && needsPreliminaryTriage && opts.preliminaryUsed < preliminaryBudget) {
    return { role: "preliminary", reason: "costly_production_triage", budgetForRole: preliminaryBudget };
  }

  return { role: "none", reason: "production_preferred", budgetForRole: 0 };
}

/**
 * Legacy v1 narrow diagnostic MCQ eligibility helper (retained for compatibility with existing unit checks).
 */
export function isMcqEligible(
  u: Unit,
  state: State,
  depth: Depth,
  baseModality: RepModality,
  now = Date.now(),
): boolean {
  if (u.status !== "active" || u.observe_only) return false;
  const kind = u.kind.trim().toLowerCase();
  if (kind !== "definition" && kind !== "distinction") return false;
  if (depth !== "recall" || baseModality !== "contrast") return false;

  const probes = u.evidence
    .map((id) => state.evidence[id])
    .filter((ev): ev is NonNullable<typeof ev> => Boolean(ev && ev.source === "probe" && ev.grade !== null));

  if (probes.some((ev) => ev.modality === "mcq")) return false;
  if (probes.some((ev) => ev.grade !== "again")) return false;

  const directTerminal = probes.filter(
    (ev) => ev.modality !== "mcq" && ev.slot !== "imported" && ev.slot !== "in_context",
  );
  if (directTerminal.length !== 1) return false;
  const only = directTerminal[0]!;
  if (only.depth !== "recall" || only.grade !== "again") return false;
  if (now - only.at < MCQ_ELIGIBILITY_GAP_MS) return false;
  return true;
}

export interface UnitDueOverride {
  due_at: number;
  created_at: number;
}

/**
 * Computes calibrated FSRS-6 (requestRetention = 0.85) spacing intervals across ALL probe depths,
 * implementing two-stage Successive Relearning:
 * - Stage 1 (miss / Show answer): short-term cold retry (`20m` first contact, `20–45m` lapse) so
 *   the learner reconstructs the pivot once working memory flushes instead of forgetting overnight.
 * - Stage 2 (same-day relearn pass within <12h of an `again`): overnight consolidation (`14h`/`20h`/`48h`),
 *   bypassing ts-fsrs's integer-day `+72h` jump and re-anchoring first-contact acquisitions without
 *   permanent FSRS lapse difficulty penalties.
 * - One-shot learner timing overrides (`dueOverrides`) take effect while newer than the latest probe
 *   without rewriting historical accuracy evidence.
 * - Downward DAG credit: clean unassisted passes refresh `rests_on` prerequisites up to depth 2.
 */
export function computeCalibratedIntervals(
  state: State,
  now: number,
  dueOverrides?: ReadonlyMap<string, UnitDueOverride>,
): Map<
  string,
  {
    next_in_ms: number;
    fsrs_recall: number;
    reviews: number;
    scheduled_interval_ms: number | null;
    schedule_kind: ScheduleKind;
  }
> {
  const sched = fsrsScheduler({ requestRetention: 0.85 });
  const out = new Map<
    string,
    {
      next_in_ms: number;
      fsrs_recall: number;
      reviews: number;
      scheduled_interval_ms: number | null;
      schedule_kind: ScheduleKind;
    }
  >();

  // Pre-collect downward DAG credit: ancestorId -> clean pass timestamps from dependents.
  const downwardCredits = new Map<string, { at: number; seq: number }[]>();
  const collectAncestors = (unitId: string, depthLeft: number, seen: Set<string>): void => {
    if (depthLeft <= 0) return;
    const u = state.units[unitId];
    if (!u) return;
    for (const pid of u.rests_on) {
      if (seen.has(pid)) continue;
      const p = state.units[pid];
      if (!p || p.status === "split" || p.status === "merged" || p.observe_only) continue;
      seen.add(pid);
      collectAncestors(pid, depthLeft - 1, seen);
    }
  };

  for (const child of Object.values(state.units)) {
    if (child.status !== "active" || child.observe_only || child.rests_on.length === 0) continue;
    const ancestors = new Set<string>();
    collectAncestors(child.id, 2, ancestors);
    if (ancestors.size === 0) continue;
    for (const evId of child.evidence) {
      const ev = state.evidence[evId];
      if (!ev || ev.source !== "probe" || ev.modality === "mcq" || ev.grade === null || ev.grade === "again" || ev.hints > 0) continue;
      for (const ancId of ancestors) {
        const anc = state.units[ancId];
        if (!anc || ev.at < anc.found_at) continue;
        let list = downwardCredits.get(ancId);
        if (!list) {
          list = [];
          downwardCredits.set(ancId, list);
        }
        list.push({ at: ev.at, seq: ev.seq });
      }
    }
  }

  for (const u of Object.values(state.units)) {
    if (u.status === "split" || u.status === "merged" || u.observe_only) continue;
    const allUnitProbes = u.evidence
      .map((id) => state.evidence[id])
      .filter((ev): ev is NonNullable<typeof ev> => Boolean(ev && ev.source === "probe" && ev.grade !== null))
      .sort((a, b) => a.at - b.at || a.seq - b.seq);

    // Clean v2 standalone MCQs advance FSRS conservatively (`hard` on clean correct, `again` on wrong/idk).
    // Legacy v1 MCQs (no mcq_role), preliminary gate misses, and assisted/revealed MCQs stay out of FSRS
    // and anchor a bounded pending check (4h clean v1 / 20m miss/assisted/preliminary).
    const isFsrsStandaloneMcq = (ev: NonNullable<(typeof allUnitProbes)[number]>) =>
      ev.modality === "mcq" &&
      ev.mcq_role === "standalone" &&
      ev.mcq_outcome !== "assisted_correct" &&
      ev.mcq_outcome !== "revealed";

    const fsrsProbes = allUnitProbes
      .filter((ev) => ev.modality !== "mcq" || isFsrsStandaloneMcq(ev))
      .map((ev) => ({
        at: ev.at,
        seq: ev.seq,
        grade: (ev.modality === "mcq" && ev.grade !== "again" ? "hard" : ev.grade!) as Grade,
        hints: ev.hints,
        implicit: false,
        isStandaloneMcq: ev.modality === "mcq",
      }));

    const nonFsrsMcqProbes = allUnitProbes.filter((ev) => ev.modality === "mcq" && !isFsrsStandaloneMcq(ev));
    const latestNonFsrsMcq = nonFsrsMcqProbes.at(-1) ?? null;
    const lastFsrsAt = fsrsProbes.at(-1)?.at ?? -1;
    const pendingMcq = latestNonFsrsMcq && latestNonFsrsMcq.at > lastFsrsAt ? latestNonFsrsMcq : null;
    const latestAnyMcq = allUnitProbes.filter((ev) => ev.modality === "mcq").at(-1) ?? null;

    // Implicit DAG credit must never clear or postpone a pending post-MCQ production check.
    const implicitRaw = (downwardCredits.get(u.id) ?? []).sort((a, b) => a.at - b.at || a.seq - b.seq);
    const merged: { at: number; seq: number; grade: Grade; hints: number; implicit: boolean; isStandaloneMcq: boolean }[] = [...fsrsProbes];
    for (const imp of implicitRaw) {
      if (pendingMcq && imp.at >= pendingMcq.at) continue;
      // Avoid double-counting an implicit credit within 4h of an existing direct or implicit event.
      const nearExisting = merged.some((e) => Math.abs(e.at - imp.at) < IMPLICIT_CREDIT_DEDUP_MS);
      if (!nearExisting) {
        merged.push({ at: imp.at, seq: imp.seq, grade: "good", hints: 0, implicit: true, isStandaloneMcq: false });
      }
    }
    merged.sort((a, b) => a.at - b.at || a.seq - b.seq);

    if (merged.length === 0) {
      if (pendingMcq) {
        const override = dueOverrides?.get(u.id);
        const mcqClean =
          pendingMcq.mcq_role !== "preliminary" &&
          pendingMcq.grade !== "again" &&
          pendingMcq.mcq_outcome !== "assisted_correct" &&
          pendingMcq.mcq_outcome !== "revealed" &&
          pendingMcq.mcq_outcome !== "idk";
        const delayMs = mcqClean ? MCQ_CLEAN_DELAY_MS : MCQ_SHORT_DELAY_MS;
        const effectiveDue =
          override && override.created_at >= pendingMcq.at ? override.due_at : pendingMcq.at + delayMs;
        const eventAt = override && override.created_at >= pendingMcq.at ? override.created_at : pendingMcq.at;
        out.set(u.id, {
          next_in_ms: Math.max(0, effectiveDue - now),
          fsrs_recall: 0,
          reviews: 0,
          scheduled_interval_ms: Math.max(0, effectiveDue - eventAt),
          schedule_kind:
            override && override.created_at >= pendingMcq.at
              ? "override"
              : pendingMcq.grade === "again"
                ? "lapse"
                : "relearn",
        });
      } else {
        out.set(u.id, {
          next_in_ms: 0,
          fsrs_recall: 0,
          reviews: 0,
          scheduled_interval_ms: null,
          schedule_kind: "first",
        });
      }
      continue;
    }

    let mem = sched.init();
    let lastAt = 0;
    let lastGrade: Grade = "good";
    let priorPasses = 0;
    let lastAgainAt: number | null = null;
    let sameDayRelearn = false;
    let lastProdPassAt: number | null = null;
    let lastProdIntervalMs: number | null = null;
    let lastWasStandaloneMcq = false;

    for (let i = 0; i < merged.length; i++) {
      const ev = merged[i]!;
      if (ev.grade === "again") {
        // Avoid double-spiking FSRS lapses/difficulty when a card fails again within 2h.
        if (lastAt === 0 || ev.at - lastAt >= REPEAT_LAPSE_GUARD_MS) {
          mem = sched.update(mem, { grade: "again", at: ev.at });
        }
        lastAgainAt = ev.at;
        sameDayRelearn = false;
      } else if (lastAgainAt !== null && ev.at - lastAgainAt < SAME_DAY_RELEARN_WINDOW_MS) {
        sameDayRelearn = true;
        lastAgainAt = null;
        priorPasses++;
        if (priorPasses === 1) {
          // First-contact acquisition passed its short retry: re-anchor cleanly without D_0(again) penalty.
          mem = sched.update(sched.init(), { grade: ev.grade === "easy" ? "good" : "hard", at: ev.at });
        } else {
          // True lapse relearned same-day: keep post-lapse stability/difficulty, advance last_review.
          mem = { ...mem, last_review: ev.at };
        }
        if (!ev.isStandaloneMcq) {
          lastProdPassAt = ev.at;
          const overnightHours = ev.grade === "hard" ? 14 : ev.grade === "good" ? 20 : 48;
          lastProdIntervalMs = overnightHours * 3600_000;
        }
      } else {
        mem = sched.update(mem, { grade: ev.grade, at: ev.at });
        priorPasses++;
        lastAgainAt = null;
        sameDayRelearn = false;
        if (!ev.isStandaloneMcq) {
          lastProdPassAt = ev.at;
          const dueMs = typeof mem.due === "number" ? mem.due : ev.at + 12 * 3600_000;
          lastProdIntervalMs = Math.max(12 * 3600_000, dueMs - ev.at);
        }
      }
      lastAt = ev.at;
      lastGrade = ev.grade;
      lastWasStandaloneMcq = ev.isStandaloneMcq;
    }

    const rawDue = typeof mem.due === "number" ? mem.due : lastAt + 12 * 3600_000;
    const stabilityDays = typeof mem.stability === "number" && Number.isFinite(mem.stability) && mem.stability > 0 ? mem.stability : 0.25;
    const override = dueOverrides?.get(u.id);
    const latestAnchorAt = pendingMcq ? Math.max(lastAt, pendingMcq.at) : lastAt;
    let effectiveDue: number;
    let scheduleKind: ScheduleKind;
    let schedulingEventAt = lastAt;
    if (override && override.created_at >= latestAnchorAt) {
      effectiveDue = override.due_at;
      scheduleKind = "override";
      schedulingEventAt = override.created_at;
    } else if (pendingMcq) {
      // Pending production check anchored to the committed non-FSRS MCQ event (never alters stability/reviews).
      const mcqClean =
        pendingMcq.mcq_role !== "preliminary" &&
        pendingMcq.grade !== "again" &&
        pendingMcq.mcq_outcome !== "assisted_correct" &&
        pendingMcq.mcq_outcome !== "revealed" &&
        pendingMcq.mcq_outcome !== "idk";
      const delayMs = mcqClean ? MCQ_CLEAN_DELAY_MS : MCQ_SHORT_DELAY_MS;
      effectiveDue = pendingMcq.at + delayMs;
      scheduleKind = pendingMcq.grade === "again" ? "lapse" : "relearn";
      schedulingEventAt = pendingMcq.at;
    } else if (lastGrade === "again") {
      const relearnDelay =
        priorPasses === 0
          ? FIRST_RELEARN_MS
          : Math.min(MAX_LAPSE_RELEARN_MS, Math.max(FIRST_RELEARN_MS, Math.round(stabilityDays * 0.05 * DAY_MS)));
      effectiveDue = lastAt + relearnDelay;
      scheduleKind = "lapse";
    } else if (sameDayRelearn) {
      const overnightHours = lastGrade === "hard" ? 14 : lastGrade === "good" ? 20 : 48;
      effectiveDue = lastAt + overnightHours * 3600_000;
      scheduleKind = "relearn";
    } else {
      effectiveDue = Math.max(rawDue, lastAt + 12 * 3600_000);
      // A unit's very first non-again pass when shaky ("hard") should not jump straight to 2+ days.
      if (priorPasses === 1 && lastGrade === "hard") {
        effectiveDue = Math.min(effectiveDue, lastAt + DAY_MS);
      }
      scheduleKind = "normal";
    }

    // Bounded recognition maintenance cap: when a standalone MCQ maintains a unit that already has
    // production history, cap its due date at 2x the last clean production interval from that pass.
    if (
      !pendingMcq &&
      scheduleKind !== "override" &&
      lastWasStandaloneMcq &&
      lastGrade !== "again" &&
      lastProdPassAt !== null &&
      lastProdIntervalMs !== null
    ) {
      const maintenanceCapDue = lastProdPassAt + 2 * lastProdIntervalMs;
      effectiveDue = Math.max(lastAt + 12 * 3600_000, Math.min(effectiveDue, maintenanceCapDue));
    }

    // If a direct production pass immediately reconstructed an MCQ miss/reveal within 12h,
    // cap its automatic overnight interval at 14h (overnight hard relearn cap).
    if (!pendingMcq && !lastWasStandaloneMcq && scheduleKind !== "override" && lastGrade !== "again" && latestAnyMcq && latestAnyMcq.grade === "again") {
      const sinceMcqMiss = lastAt - latestAnyMcq.at;
      if (sinceMcqMiss >= 0 && sinceMcqMiss < SAME_DAY_RELEARN_WINDOW_MS) {
        effectiveDue = Math.min(effectiveDue, lastAt + MCQ_RETRY_OVERNIGHT_CAP_MS);
        scheduleKind = "relearn";
      }
    }

    const scheduledIntervalMs = Math.max(0, effectiveDue - schedulingEventAt);
    const nextInMs = Math.max(0, effectiveDue - now);
    const elapsedDays = Math.max(0, (now - lastAt) / DAY_MS);
    const fsrsRecall =
      elapsedDays < 1
        ? Math.pow(1 + (19 / 81) * (elapsedDays / stabilityDays), -0.5)
        : sched.recall(mem, now);
    out.set(u.id, {
      next_in_ms: nextInMs,
      fsrs_recall: fsrsRecall,
      reviews: merged.length,
      scheduled_interval_ms: scheduledIntervalMs,
      schedule_kind: scheduleKind,
    });
  }

  return out;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "from", "this", "into", "over", "each", "when", "where",
  "which", "what", "why", "how", "are", "was", "were", "have", "has", "not", "can", "use", "using",
  "its", "their", "than", "then", "they", "them", "only", "also", "more", "most", "some", "such",
  "same", "both", "one", "two", "all", "any", "per", "via",
]);

function contentTokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Picks up to 2 closely related due companion units to bundle with `primary` into a single
 * high-yield multi-unit synthesis rep (clearing 2-3 cards in one ~45s task).
 * Prioritizes direct `rests_on` neighbors, then same-topic / high-lexical-overlap due siblings.
 */
export function pickSynthesisCluster(
  primary: Unit,
  state: State,
  dueIds: ReadonlySet<string>,
  maxCompanions = 2,
): Unit[] {
  if (maxCompanions <= 0 || !dueIds.has(primary.id)) return [];
  const primaryTopic = primary.topic?.trim().toLowerCase() || null;
  const primaryTokens = contentTokens(primary.text);
  const prereqSet = new Set(primary.rests_on);

  const scored: { unit: Unit; score: number }[] = [];
  for (const other of Object.values(state.units)) {
    if (other.id === primary.id || other.status !== "active" || other.observe_only) continue;
    if (!dueIds.has(other.id)) continue;
    if (hasPendingMcqProductionCheck(other, state)) continue;

    const isDirectNeighbor = prereqSet.has(other.id) || other.rests_on.includes(primary.id);
    const otherTopic = other.topic?.trim().toLowerCase() || null;
    const sameTopic = Boolean(primaryTopic && otherTopic && primaryTopic === otherTopic);

    const otherTokens = contentTokens(other.text);
    let overlap = 0;
    for (const tok of primaryTokens) {
      if (otherTokens.has(tok)) overlap++;
    }

    if (!isDirectNeighbor && !sameTopic && overlap < 3) continue;
    if (!isDirectNeighbor && sameTopic && overlap < 1) continue;

    const score = (isDirectNeighbor ? 10 : 0) + (sameTopic ? 4 : 0) + overlap * 1.5;
    scored.push({ unit: other, score });
  }

  scored.sort((a, b) => b.score - a.score || a.unit.found_at - b.unit.found_at);
  return scored.slice(0, maxCompanions).map((x) => x.unit);
}

const CODE_CUE_RE =
  /(\bdef\s|\btorch\.|\bnp\.|\beinsum\b|\bdim=|\bkeepdim|\bbackward\b|\bforward\b|\bpython\b|\bpytorch\b|`[^`]+`)/i;

const FORMULA_CUE_RE =
  /(\\frac|\\sum|\\prod|\\partial|\\nabla|\\int|\bO\(|[A-Za-z0-9_)\]]\s*=\s*[^=])/i;

const STRUCTURAL_CUE_RE =
  /(\$|\\[a-z]+|=|def\s|torch\.|np\.|shape|matrix|tensor|variance|gradient|softmax|kernel|sum_|log|O\(|complexity|recurrence|algorithm|equation|proof|step)/i;

function stableBucket(id: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % mod;
}

/**
 * Selects the highest-leverage rep modality for unit `u`:
 * - `synthesis`: when 1-2 related due units are bundled into one compact multi-unit task
 * - `contrast`: sharp 1-line boundary/distinction check for definitions & distinctions
 * - `faded_skeleton`: code/formula scaffold ONLY for genuine code or a bounded fraction of
 *   symbolic formula first-contact/relearn units (never prose mad-libs on conceptual explanations)
 * - `fix_bug`: compact 3-6 line snippet/derivation with ONE planted subtle bug on transfer/rebuild reps
 * - `direct`: standard concise generative prompt
 */
export function pickRepModality(
  u: Unit,
  state: State | undefined,
  depth: Depth,
  bundledUnits: readonly { id: string }[] = [],
): RepModality {
  if (bundledUnits.length > 0) return "synthesis";
  const kind = u.kind.trim().toLowerCase();
  if (kind === "distinction" || kind === "definition") return "contrast";

  const structural =
    STRUCTURAL_CUE_RE.test(u.text) || kind === "move" || kind === "mechanism" || kind === "result";
  if (!structural) return "direct";

  const probes = state
    ? u.evidence
        .map((id) => state.evidence[id])
        .filter((ev): ev is NonNullable<typeof ev> => Boolean(ev && ev.source === "probe" && ev.modality !== "mcq" && ev.grade !== null))
        .sort((a, b) => a.at - b.at || a.seq - b.seq)
    : [];
  const passes = probes.filter((ev) => ev.grade !== "again").length;
  const lastGrade = probes.at(-1)?.grade ?? null;

  if (passes === 0 || lastGrade === "again") {
    if (CODE_CUE_RE.test(u.text)) return "faded_skeleton";
    if (
      FORMULA_CUE_RE.test(u.text) &&
      (kind === "move" || kind === "mechanism" || kind === "rule" || kind === "result") &&
      stableBucket(u.id, 3) === 0
    ) {
      return "faded_skeleton";
    }
    return "direct";
  }
  if (depth === "use" || depth === "rebuild") return "fix_bug";
  return "direct";
}

/**
 * Picks the best active depth for a micro-production drill rep on unit `u`.
 * Promotes depth strictly on demonstrated (non-"again") performance—never on repeated misses—
 * caps pure `definition` units at `explain` (no artificial transfer essays on vocabulary),
 * and includes `explain` before promoting to transfer `use`.
 */
export function pickDrillDepth(u: Unit, state?: State): Depth {
  const isDefinition = u.kind.trim().toLowerCase() === "definition";
  if (!state) {
    if (u.rests_on.length > 0 && !u.rebuilt_once) return "rebuild";
    if (u.memory_reviews >= 2) return isDefinition ? "explain" : "use";
    if (u.rests_on.length > 0) return "rebuild";
    return u.memory_reviews === 1 ? "explain" : "recall";
  }
  const probes = u.evidence
    .map((id) => state.evidence[id])
    .filter(
      (ev) =>
        ev !== undefined &&
        ev.source === "probe" &&
        ev.modality !== "mcq" &&
        ev.grade !== null &&
        ev.grade !== "again",
    );

  const passes = probes.length;
  const explainedOnce = probes.some((ev) => ev!.depth === "explain");

  if (u.rests_on.length > 0 && !u.rebuilt_once) return "rebuild";
  if (passes === 0) return u.rests_on.length > 0 ? "rebuild" : "recall";
  if (isDefinition) return "explain";
  if (passes === 1) return explainedOnce ? "use" : "explain";
  return "use";
}
