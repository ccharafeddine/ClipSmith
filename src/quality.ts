// Export quality metadata (v2): the quality tier (CRF / preset) and the output
// resolution cap. Display metadata + types only — the backend (`encoders.rs` /
// `formats.rs`) owns the real per-codec CRF/preset values, and the resolution
// cap is applied on the frontend as smaller canvas dimensions (see
// `reframe.ts` `capShorterSide`), so this file never encodes ffmpeg args.

/** Quality tier id. Mirrors `encoders::QualityTier` (serde lowercase). */
export type QualityTier = "draft" | "balanced" | "high";

export interface QualityInfo {
  id: QualityTier;
  label: string;
  /** Muted hint under the chips (approximate libx264 CRF). */
  detail: string;
}

// High first: it's the default and equals v1's fixed CRF 18 / medium encode.
export const QUALITY_TIERS: QualityInfo[] = [
  { id: "high", label: "High", detail: "Near-lossless, larger (CRF 18)" },
  { id: "balanced", label: "Balanced", detail: "Good quality, smaller (CRF 23)" },
  { id: "draft", label: "Draft", detail: "Fast, smallest (CRF 28)" },
];

/** Look up tier metadata by id, defaulting to High for anything unknown. */
export function qualityInfo(id: string): QualityInfo {
  return QUALITY_TIERS.find((q) => q.id === id) ?? QUALITY_TIERS[0];
}

export interface ResolutionOption {
  id: string;
  label: string;
  /** Cap on the output's shorter side in pixels; `null` keeps the source size. */
  maxShorter: number | null;
}

// Source first (default). Caps only downscale — a cap above the source is a no-op.
export const RESOLUTIONS: ResolutionOption[] = [
  { id: "source", label: "Source", maxShorter: null },
  { id: "1080", label: "1080p", maxShorter: 1080 },
  { id: "720", label: "720p", maxShorter: 720 },
  { id: "480", label: "480p", maxShorter: 480 },
];

/** Look up a resolution option by id, defaulting to Source. */
export function resolutionOption(id: string): ResolutionOption {
  return RESOLUTIONS.find((r) => r.id === id) ?? RESOLUTIONS[0];
}
