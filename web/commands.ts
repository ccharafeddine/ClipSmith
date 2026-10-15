// ClipSmith's Tauri commands, implemented for the browser build. Each mirrors
// its Rust counterpart in src-tauri/src (same arguments, results and events),
// running ffmpeg.wasm (libx264 / libvpx-vp9 / AAC / Opus) instead of the
// bundled ffmpeg. Hardware encoders, link import and the update check are
// desktop-only.
import type { AnalyzeResult, ExportOptions, UpdateInfo, VideoMeta } from "../src/ipc";
import { analyzeSubject, cancelAnalyze } from "./analyze";
import { emitLocal } from "./shim/event";
import { addFile, basename, download, DOWNLOADS, getFile, putFile, urlFor } from "./shim/vfs";
import { cancel, ffmpeg, grabFrames, measureFps, mountInput, probe, probeElement, run, sniffCodec, take } from "./shim/engine";
import { mp4Keyframes } from "./shim/mp4";

type Reframe = NonNullable<ExportOptions["reframe"]> & {
  canvasW: number; canvasH: number; strategy: "blur" | "pad" | "crop"; anchor?: "start" | "center" | "end";
  padColor?: string | null; crop?: { x: number; y: number; w: number; h: number } | null;
  auto?: { cropW: number; cropH: number; x: { t: number; v: number }[]; y: { t: number; v: number }[] } | null;
};

const even = (v: number) => Math.max(2, Math.floor(v) & ~1);
const evenFloor = (v: number) => Math.max(0, Math.floor(v) & ~1);

// ---- probe / keyframes -----------------------------------------------------

async function probeVideo({ path }: { path: string }): Promise<VideoMeta> {
  const e = getFile(path);
  const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
  try {
    const m = await probeElement(urlFor(path));
    if (m.width > 0 && m.duration > 0 && Number.isFinite(m.duration)) {
      const [codec, fps] = await Promise.all([sniffCodec(e.blob), measureFps(urlFor(path))]);
      return { duration_secs: m.duration, width: m.width, height: m.height, fps_num: fps?.num ?? 30, fps_den: fps?.den ?? 1, codec: codec || "video", container: ext };
    }
  } catch { /* not playable here: ffprobe below (HEVC, ProRes, AVI, ...) */ }
  const p = await probe(path);
  const v = p.streams?.find((s) => s.codec_type === "video");
  if (!v) throw "no video stream found";
  const dur = Number(p.format?.duration ?? v.duration ?? 0);
  if (!(dur > 0)) throw "could not read the video duration";
  const [num, den] = (v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate ?? "30/1").split("/").map(Number);
  const rot = Math.abs(Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180 === 90;
  return { duration_secs: dur, width: (rot ? v.height : v.width) ?? 0, height: (rot ? v.width : v.height) ?? 0, fps_num: num || 30, fps_den: den || 1, codec: v.codec_name ?? "", container: ext };
}

/** Mirrors list_keyframes. MP4/MOV are read from their sample tables (no
 *  engine download); other containers use ffprobe in ffmpeg.wasm. */
async function listKeyframes({ path }: { path: string }): Promise<number[]> {
  const e = getFile(path);
  const fromMp4 = await mp4Keyframes(e.blob).catch(() => null);
  if (fromMp4?.length) return fromMp4;
  const f = await ffmpeg();
  const m = await mountInput(f, path);
  try {
    await f.ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "json", m.file, "-o", "/kf.json"]);
    const j = JSON.parse(String(await f.readFile("/kf.json", "utf8"))) as { packets?: { pts_time?: string; flags?: string }[] };
    await f.deleteFile("/kf.json").catch(() => undefined);
    const ks = (j.packets ?? []).filter((p) => p.flags?.includes("K") && p.pts_time !== undefined).map((p) => Number(p.pts_time));
    return [...new Set([0, ...ks])].sort((a, b) => a - b);
  } finally { await m.unmount(); }
}

// ---- filmstrip / proxy -----------------------------------------------------

const proxies = new Map<string, string>();
const proxyJobs = new Map<string, Promise<string>>();

/** Mirrors generate_proxy: a <=1280 px H.264 copy for codecs the browser can't decode. */
function generateProxy({ path }: { path: string }): Promise<string> {
  let job = proxyJobs.get(path);
  if (!job) {
    job = (async () => {
      const f = await ffmpeg();
      const m = await mountInput(f, path);
      try {
        await run(["-v", "info", "-i", m.file, "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "/proxy.mp4"]);
      } finally { await m.unmount(); }
      const out = addFile(await take("/proxy.mp4", "video/mp4"), "proxy.mp4", "/proxy");
      proxies.set(path, urlFor(out));
      return out;
    })();
    proxyJobs.set(path, job);
    job.catch(() => proxyJobs.delete(path));
  }
  return job;
}

/** Mirrors filmstrip::generate: `count` (4-20) square 144 px centre crops, side by side. */
async function generateFilmstrip({ path, durationSecs, count }: { path: string; durationSecs: number; count: number }): Promise<string> {
  const SIZE = 144;
  const n = Math.max(4, Math.min(20, Math.round(count) || 10));
  const dur = durationSecs > 0.05 ? durationSecs : 1;
  const times = Array.from({ length: n }, (_, i) => ((i + 0.5) * dur) / n);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE * n;
  canvas.height = SIZE;
  const draw = (ctx: CanvasRenderingContext2D, v: HTMLVideoElement, i: number) => {
    const s = Math.min(v.videoWidth, v.videoHeight);
    ctx.drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, i * SIZE, 0, SIZE, SIZE);
  };
  try {
    await grabFrames(proxies.get(path) ?? urlFor(path), times, draw, canvas);
  } catch {
    if (!proxies.has(path)) await generateProxy({ path });
    await grabFrames(proxies.get(path)!, times, draw, canvas);
  }
  return canvas.toDataURL("image/png");
}

// ---- export ----------------------------------------------------------------

type Filter = { kind: "none" } | { kind: "simple"; vf: string } | { kind: "complex"; fc: string };

function piecewise(points: { t: number; v: number }[]): string {
  if (!points.length) return "0";
  if (points.length === 1 || points.every((p) => Math.abs(p.v - points[0].v) < 1e-6)) return points[0].v.toFixed(3);
  const n = points.length;
  let expr = points[n - 1].v.toFixed(3);
  for (let i = n - 2; i >= 0; i--) {
    const a = points[i], b = points[i + 1];
    const dt = b.t - a.t;
    const seg = Math.abs(dt) < 1e-6 ? b.v.toFixed(3) : `(${a.v.toFixed(3)}+(${(b.v - a.v).toFixed(3)})*clip((t-${a.t.toFixed(4)})/${dt.toFixed(4)}\\,0\\,1))`;
    expr = `if(lt(t\\,${b.t.toFixed(4)})\\,${seg}\\,${expr})`;
  }
  return expr;
}

/** Mirrors cutter::Reframe::to_filter. */
function reframeFilter(r: Reframe | null | undefined): Filter {
  if (!r) return { kind: "none" };
  const w = even(r.canvasW), h = even(r.canvasH);
  const anchor = r.anchor ?? "center";
  if (r.strategy === "crop") {
    if (r.auto) {
      const cw = even(r.auto.cropW), ch = even(r.auto.cropH);
      return { kind: "simple", vf: `crop=w=${cw}:h=${ch}:x=max(0\\,min(iw-ow\\,${piecewise(r.auto.x)})):y=max(0\\,min(ih-oh\\,${piecewise(r.auto.y)})),scale=${w}:${h},setsar=1` };
    }
    if (!r.crop) return { kind: "none" };
    const c = r.crop;
    const base = `crop=${even(c.w)}:${even(c.h)}:${evenFloor(c.x)}:${evenFloor(c.y)}`;
    return { kind: "simple", vf: even(c.w) === w && even(c.h) === h ? base : `${base},scale=${w}:${h},setsar=1` };
  }
  if (r.strategy === "pad") {
    const color = r.padColor && /^#[0-9a-fA-F]{6}$/.test(r.padColor) ? `0x${r.padColor.slice(1)}` : "black";
    const [x, y] = anchor === "start" ? ["0", "0"] : anchor === "end" ? ["ow-iw", "oh-ih"] : ["(ow-iw)/2", "(oh-ih)/2"];
    return { kind: "simple", vf: `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:${x}:${y}:${color},setsar=1` };
  }
  const sigma = Math.min(40, Math.max(10, Math.min(w, h) * 0.04));
  const [ox, oy] = anchor === "start" ? ["0", "0"] : anchor === "end" ? ["W-w", "H-h"] : ["(W-w)/2", "(H-h)/2"];
  return { kind: "complex", fc: `[0:v]split=2[bg][fg];[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=${sigma.toFixed(2)}[bgb];[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=${ox}:${oy},setsar=1[v]` };
}

const MUXER: Record<string, string> = { mp4: "mp4", mov: "mov", mkv: "matroska", webm: "webm" };
const MIME: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm" };

/** Mirrors formats::OutputFormat::encode_args with the libx264 encoder. */
function encodeArgs(fmt: string, tier: string, out: string): string[] {
  const h264 = fmt !== "webm";
  const t = tier === "draft" || tier === "balanced" ? tier : "high";
  const video = h264
    ? ["-c:v", "libx264", "-preset", t === "draft" ? "veryfast" : "medium", "-crf", t === "draft" ? "28" : t === "balanced" ? "23" : "18", "-pix_fmt", "yuv420p"]
    // ffmpeg.wasm's libvpx-vp9 traps (null function / out-of-bounds) in this
    // core build, so WebM uses VP8 here (desktop: VP9). Realtime preset: the
    // wasm encoder is single-threaded. CRF mapped onto VP8's 4-63 scale.
    : ["-c:v", "libvpx", "-b:v", "0", "-crf", t === "draft" ? "20" : t === "balanced" ? "14" : "10", "-qmin", "4", "-qmax", "48", "-deadline", "realtime", "-cpu-used", "8", "-auto-alt-ref", "0", "-pix_fmt", "yuv420p"];
  const audio = h264 ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "libopus", "-b:a", "128k"];
  const container = fmt === "mp4" || fmt === "mov" ? ["-movflags", "+faststart"] : [];
  return [...video, ...audio, ...container, "-avoid_negative_ts", "make_zero", "-f", MUXER[fmt] ?? "mp4", "-y", out];
}

/** Mirrors export_clip: frame-accurate re-encode (optionally reframed), or a
 *  lossless stream copy; emits "export-progress" (0..1). The result is saved
 *  as a browser download under the name picked in the save dialog. */
async function exportClip(a: { input: string; output: string; start: number; duration: number; options: ExportOptions }): Promise<void> {
  const { input, output, start, duration, options: o } = a;
  const name = basename(output);
  const ext = (name.split(".").pop() ?? "mp4").toLowerCase();
  const out = `/out.${ext}`;
  const f = await ffmpeg();
  const m = await mountInput(f, input);
  const args = ["-v", "info", "-ss", start.toFixed(6), "-i", m.file, "-t", duration.toFixed(6)];
  if (o.lossless) {
    args.push("-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-y", out);
  } else {
    const flt = reframeFilter(o.reframe as Reframe | null);
    if (flt.kind === "simple") args.push("-vf", flt.vf, "-map", "0:v:0");
    else if (flt.kind === "complex") args.push("-filter_complex", flt.fc, "-map", "[v]");
    else args.push("-map", "0:v:0");
    if (o.mute) args.push("-an");
    else {
      args.push("-map", "0:a?");
      const vol = Math.min(8, Math.max(0, o.volume ?? 1));
      if (Math.abs(vol - 1) > 1e-3) args.push("-af", `volume=${vol.toFixed(3)}`);
    }
    args.push(...encodeArgs(MUXER[o.format] ? o.format : "mp4", o.tier, out));
  }
  emitLocal("export-progress", 0);
  try {
    await run(args, { outSecs: duration, onProgress: (r) => emitLocal("export-progress", r) });
  } finally { await m.unmount(); }
  const blob = await take(out, MIME[ext] ?? "application/octet-stream");
  putFile(output, blob);
  download(blob, name);
  emitLocal("export-progress", 1);
}

async function availableFormats(): Promise<string[]> {
  // The ffmpeg.wasm core ships libx264, libvpx-vp9, AAC and libopus.
  return ["mp4", "mov", "mkv", "webm"];
}

async function detectEncoder(): Promise<string> { return "Software (libx264), hardware encoders need the desktop app"; }

async function defaultSavePath({ filename }: { filename: string }): Promise<string> { return `${DOWNLOADS}/${filename}`; }

async function downloadVideo(): Promise<string> { throw "Importing from a link runs in the desktop app. In the browser, open or drop a video file."; }
async function cancelDownload(): Promise<void> {}
async function cancelExport(): Promise<void> { cancel(); }

async function checkForUpdate(): Promise<UpdateInfo> {
  return { current: __APP_VERSION__, latest: __APP_VERSION__, isNewer: false, notes: "", url: `${__APP_REPO__}/releases/latest` };
}

export const commands = {
  probe_video: probeVideo,
  list_keyframes: listKeyframes,
  generate_filmstrip: generateFilmstrip,
  generate_proxy: generateProxy,
  export_clip: exportClip,
  cancel_export: cancelExport,
  available_formats: availableFormats,
  detect_encoder: detectEncoder,
  default_save_path: defaultSavePath,
  download_video: downloadVideo,
  cancel_download: cancelDownload,
  analyze_subject: (a: { input: string; duration: number; fps: number | null }): Promise<AnalyzeResult> => analyzeSubject(a),
  cancel_analyze: cancelAnalyze,
  check_for_update: checkForUpdate,
};
