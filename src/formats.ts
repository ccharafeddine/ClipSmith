// Output format metadata (v2). ClipSmith exports MP4 by default but can convert
// to other containers/codecs. This is display metadata only; the backend
// (`formats.rs`) owns the real ffmpeg args and decides which formats the bundled
// ffmpeg can actually produce (see `availableFormats`).

export interface OutputFormatInfo {
  /** id == file extension, matches `formats::OutputFormat::id`. */
  id: string;
  label: string;
  /** Codecs, shown as a muted hint (e.g. "H.264 · AAC"). */
  detail: string;
  /** Whether the encoder (hardware/software) choice applies. */
  h264: boolean;
}

export const OUTPUT_FORMATS: OutputFormatInfo[] = [
  { id: "mp4", label: "MP4", detail: "H.264 · AAC", h264: true },
  { id: "mov", label: "MOV", detail: "H.264 · AAC", h264: true },
  { id: "mkv", label: "MKV", detail: "H.264 · AAC", h264: true },
  { id: "webm", label: "WebM", detail: "VP9 · Opus", h264: false },
];

/** Look up format metadata by id, defaulting to MP4 for anything unknown. */
export function formatInfo(id: string): OutputFormatInfo {
  return OUTPUT_FORMATS.find((f) => f.id === id) ?? OUTPUT_FORMATS[0];
}
