// Browser port of src-tauri/src/analyze.rs (Auto-Reframe's analyze pass): the
// same Ultraface (faces) and NanoDet-Plus (persons) ONNX models, thresholds and
// decode, run with onnxruntime-web (wasm, threads when cross-origin isolated)
// instead of tract. Frames are sampled at `fps` with <video> seeks + canvas
// (direct resize, like ffmpeg's scale=WxH); scene cuts use the same ffmpeg
// `scene` filter in ffmpeg.wasm. Same result shape: { frames, sceneCuts }.
import type { AnalyzeResult, Detection } from "../src/ipc";
import { emitLocal } from "./shim/event";
import { urlFor } from "./shim/vfs";
import { ffmpeg, mountInput, run } from "./shim/engine";

type Ort = typeof import("onnxruntime-web/wasm");
type Session = import("onnxruntime-web/wasm").InferenceSession;

const FACE_W = 320, FACE_H = 240, FACE_SCORE_THR = 0.7, FACE_IOU_THR = 0.3;
const PERSON_W = 416, PERSON_H = 416, PERSON_SCORE_THR = 0.4, PERSON_IOU_THR = 0.5;
const STRIDES = [8, 16, 32, 64], REG_MAX = 7, CLASSES = 80, PERSON_CLASS = 0, CH = CLASSES + 4 * (REG_MAX + 1);
const MEAN = [103.53, 116.28, 123.675], STD = [57.375, 57.12, 58.395]; // BGR
const SCENE_THR = 0.4;
const CANCELLED = "Analysis cancelled.";

let cancelled = false;
let models: Promise<{ ort: Ort; face: Session; person: Session }> | null = null;
const root = () => new URL(import.meta.env.BASE_URL, location.href).href;

function loadModels() {
  models ??= (async () => {
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = root() + "ort/";
    ort.env.logLevel = "error";
    ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" as const, logSeverityLevel: 3 as const };
    const [face, person] = await Promise.all([
      ort.InferenceSession.create(root() + "models/ultraface-320.onnx", opts),
      ort.InferenceSession.create(root() + "models/nanodet-plus-m-416.onnx", opts),
    ]);
    return { ort, face, person };
  })();
  models.catch(() => (models = null));
  return models;
}

const area = (d: Detection) => Math.max(0, (d.x2 - d.x1) * (d.y2 - d.y1));
function iou(a: Detection, b: Detection): number {
  const iw = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const ih = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = iw * ih, union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}
function nms(dets: Detection[], thr: number): Detection[] {
  const keep: Detection[] = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score)) if (keep.every((k) => iou(d, k) <= thr)) keep.push(d);
  return keep;
}

function decodeUltraface(scores: Float32Array, boxes: Float32Array): Detection[] {
  const n = Math.min(scores.length / 2, boxes.length / 4);
  const dets: Detection[] = [];
  for (let i = 0; i < n; i++) {
    const p = scores[i * 2 + 1];
    if (p >= FACE_SCORE_THR) dets.push({ x1: boxes[i * 4], y1: boxes[i * 4 + 1], x2: boxes[i * 4 + 2], y2: boxes[i * 4 + 3], score: p });
  }
  return nms(dets, FACE_IOU_THR);
}

function dfl(bins: Float32Array): number {
  let max = -Infinity;
  for (const v of bins) max = Math.max(max, v);
  let sum = 0, acc = 0;
  for (let j = 0; j < bins.length; j++) { const e = Math.exp(bins[j] - max); sum += e; acc += j * e; }
  return sum <= 0 ? 0 : acc / sum;
}

const PRIORS: [number, number, number][] = STRIDES.flatMap((s) => {
  const g = Math.ceil(PERSON_W / s);
  const out: [number, number, number][] = [];
  for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++) out.push([(gx + 0.5) * s, (gy + 0.5) * s, s]);
  return out;
});

function decodeNanodet(out: Float32Array): Detection[] {
  const bins = REG_MAX + 1;
  const dets: Detection[] = [];
  PRIORS.forEach(([cx, cy, s], i) => {
    const base = i * CH;
    if (base + CH > out.length) return;
    const score = out[base + PERSON_CLASS]; // already sigmoid inside the graph
    if (score < PERSON_SCORE_THR) return;
    const r = base + CLASSES;
    const dl = dfl(out.subarray(r, r + bins)) * s, dt = dfl(out.subarray(r + bins, r + 2 * bins)) * s;
    const dr = dfl(out.subarray(r + 2 * bins, r + 3 * bins)) * s, db = dfl(out.subarray(r + 3 * bins, r + 4 * bins)) * s;
    dets.push({ x1: (cx - dl) / PERSON_W, y1: (cy - dt) / PERSON_H, x2: (cx + dr) / PERSON_W, y2: (cy + db) / PERSON_H, score });
  });
  return nms(dets, PERSON_IOU_THR);
}

function faceInput(px: Uint8ClampedArray): Float32Array {
  const hw = FACE_W * FACE_H, d = new Float32Array(3 * hw);
  for (let i = 0; i < hw; i++) for (let c = 0; c < 3; c++) d[c * hw + i] = (px[i * 4 + c] - 127) / 128;
  return d;
}
function personInput(px: Uint8ClampedArray): Float32Array {
  const hw = PERSON_W * PERSON_H, d = new Float32Array(3 * hw);
  for (let i = 0; i < hw; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    d[i] = (b - MEAN[0]) / STD[0];
    d[hw + i] = (g - MEAN[1]) / STD[1];
    d[2 * hw + i] = (r - MEAN[2]) / STD[2];
  }
  return d;
}

async function sceneCuts(input: string, duration: number, onProgress: (r: number) => void): Promise<number[]> {
  const f = await ffmpeg();
  const m = await mountInput(f, input);
  try {
    await run(["-v", "info", "-i", m.file, "-an", "-vf", `scale=320:-2,select='gt(scene,${SCENE_THR})',metadata=print:file=/scene.txt`, "-f", "null", "-"], { outSecs: duration, onProgress });
    const text = String(await f.readFile("/scene.txt", "utf8").catch(() => ""));
    await f.deleteFile("/scene.txt").catch(() => undefined);
    const cuts = [...text.matchAll(/pts_time:([\d.]+)/g)].map((x) => Number(x[1])).filter(Number.isFinite);
    return [...new Set(cuts)].sort((a, b) => a - b);
  } finally { await m.unmount(); }
}

/** Mirrors analyze_subject: emits "analyze-progress" (0..1), cancellable. */
export async function analyzeSubject({ input, duration, fps }: { input: string; duration: number; fps: number | null }): Promise<AnalyzeResult> {
  cancelled = false;
  const rate = Math.min(15, Math.max(0.5, fps ?? 3));
  const total = Math.max(1, Math.ceil(Math.max(0, duration) * rate));
  emitLocal("analyze-progress", 0);
  const { ort, face, person } = await loadModels();
  if (cancelled) throw CANCELLED;

  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = urlFor(input);
  await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej("This browser can't decode the video for analysis."); });
  const fc = new OffscreenCanvas(FACE_W, FACE_H).getContext("2d", { willReadFrequently: true })!;
  const pc = new OffscreenCanvas(PERSON_W, PERSON_H).getContext("2d", { willReadFrequently: true })!;

  const frames: AnalyzeResult["frames"] = [];
  try {
    for (let i = 0; i < total; i++) {
      if (cancelled) throw CANCELLED;
      const t = i / rate;
      if (t > v.duration) break;
      await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = Math.min(t, Math.max(0, v.duration - 0.04)); });
      fc.drawImage(v, 0, 0, FACE_W, FACE_H);
      pc.drawImage(v, 0, 0, PERSON_W, PERSON_H);
      const fo = await face.run({ [face.inputNames[0]]: new ort.Tensor("float32", faceInput(fc.getImageData(0, 0, FACE_W, FACE_H).data), [1, 3, FACE_H, FACE_W]) });
      const po = await person.run({ [person.inputNames[0]]: new ort.Tensor("float32", personInput(pc.getImageData(0, 0, PERSON_W, PERSON_H).data), [1, 3, PERSON_H, PERSON_W]) });
      frames.push({
        t,
        faces: decodeUltraface(fo[face.outputNames[0]].data as Float32Array, fo[face.outputNames[1]].data as Float32Array),
        persons: decodeNanodet(po[person.outputNames[0]].data as Float32Array),
      });
      emitLocal("analyze-progress", Math.min(0.9, (0.9 * (i + 1)) / total));
    }
  } finally {
    v.removeAttribute("src");
    v.load();
  }
  if (cancelled) throw CANCELLED;
  const cuts = await sceneCuts(input, duration, (r) => emitLocal("analyze-progress", 0.9 + 0.1 * r)).catch((e) => { if (cancelled) throw CANCELLED; throw e; });
  emitLocal("analyze-progress", 1);
  return { frames, sceneCuts: cuts };
}

export async function cancelAnalyze(): Promise<void> {
  cancelled = true;
  const { cancel } = await import("./shim/engine");
  cancel();
}
