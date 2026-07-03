//! Hardware H.264 encoder detection (v2).
//!
//! The export re-encode (see [`crate::cutter`]) defaults to libx264, but a
//! reframe — blur-fill especially, and the Tier 2 analysis pass on top — makes
//! software-only encoding slow. Where the machine has a usable hardware encoder
//! we prefer it: `h264_videotoolbox` (macOS), or `h264_nvenc` / `h264_qsv` /
//! `h264_amf` (Windows).
//!
//! ## Why a test-encode, not `-encoders`
//!
//! An encoder being *listed* in the ffmpeg build does not mean it *works*: a
//! Windows build ships nvenc/qsv/amf unconditionally, but nvenc needs an NVIDIA
//! GPU present, qsv an Intel iGPU, amf an AMD GPU. So detection does a tiny
//! 5-frame test-encode of a synthetic source with the *exact* codec + quality
//! flags the export would use, and only accepts the encoder if that exits 0.
//! Any failure (missing hardware, unsupported flag, driver issue) falls back —
//! ultimately to libx264, which is always correct, just slower. Detection is
//! cached for the app session ([`EncoderCache`]).
//!
//! ## Quality
//!
//! Each vendor exposes a different constant-quality knob; the values below aim
//! to be visually comparable to libx264 CRF 18. Because the probe uses these
//! same flags, an unsupported combination self-rejects into the fallback rather
//! than shipping a broken export.
//!
//! MAINTAINER NOTE: these hardware quality flags could not be validated against
//! real GPUs in the dev environment. Confirm output quality on live hardware /
//! CI and tune the per-vendor knobs (`-q:v`, `-cq`, `-global_quality`, `-qp_*`)
//! if a vendor's default drifts from the libx264 baseline.

use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// Export quality tier, chosen in the UI. Maps to a per-encoder constant-quality
/// value (and, for libx264, an x264 preset): higher tiers spend more bits/time
/// for quality, lower tiers encode faster and smaller. Mirrors the frontend
/// `QualityTier` union, lowercased. Defaults to [`High`](Self::High), which is
/// v1's fixed CRF 18 / `medium` — so an export left untouched is byte-for-byte
/// the pre-v2 behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QualityTier {
    /// Fast, smaller files: higher CRF / faster preset.
    Draft,
    /// A middle ground.
    Balanced,
    /// Visually near-lossless (v1's CRF 18 / `medium`).
    #[default]
    High,
}

impl QualityTier {
    /// libx264 `(crf, preset)`. High is v1's exact CRF 18 / `medium`.
    fn x264(self) -> (u8, &'static str) {
        match self {
            Self::Draft => (28, "veryfast"),
            Self::Balanced => (23, "medium"),
            Self::High => (18, "medium"),
        }
    }

    /// VideoToolbox `-q:v` (0-100, **higher = better**).
    fn videotoolbox_q(self) -> u8 {
        match self {
            Self::Draft => 40,
            Self::Balanced => 50,
            Self::High => 60,
        }
    }

    /// NVENC `-cq` (lower = better).
    fn nvenc_cq(self) -> u8 {
        match self {
            Self::Draft => 28,
            Self::Balanced => 23,
            Self::High => 19,
        }
    }

    /// Quick Sync `-global_quality` (lower = better).
    fn qsv_gq(self) -> u8 {
        match self {
            Self::Draft => 30,
            Self::Balanced => 25,
            Self::High => 20,
        }
    }

    /// AMF constant `-qp_i`/`-qp_p` (lower = better).
    fn amf_qp(self) -> u8 {
        match self {
            Self::Draft => 28,
            Self::Balanced => 24,
            Self::High => 20,
        }
    }
}

/// An H.264 encoder ClipSmith can drive. `X264` is the always-available
/// software fallback; the rest are hardware-accelerated.
///
/// Construction is platform-gated (see [`CANDIDATES`]): only VideoToolbox is
/// ever built on macOS, only nvenc/qsv/amf on Windows. `allow(dead_code)` keeps
/// the full set defined on every platform without tripping the dead-code lint
/// for the variants that platform never constructs.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoEncoder {
    X264,
    VideoToolbox,
    Nvenc,
    Qsv,
    Amf,
}

/// Hardware candidates to probe, in priority order, for the host platform.
#[cfg(target_os = "macos")]
const CANDIDATES: &[VideoEncoder] = &[VideoEncoder::VideoToolbox];
#[cfg(target_os = "windows")]
const CANDIDATES: &[VideoEncoder] = &[VideoEncoder::Nvenc, VideoEncoder::Qsv, VideoEncoder::Amf];
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const CANDIDATES: &[VideoEncoder] = &[];

impl VideoEncoder {
    /// A short, user-facing label for the encoder (shown in the export panel).
    pub fn display_name(self) -> &'static str {
        match self {
            Self::X264 => "Software (libx264)",
            Self::VideoToolbox => "Apple VideoToolbox",
            Self::Nvenc => "NVIDIA NVENC",
            Self::Qsv => "Intel Quick Sync",
            Self::Amf => "AMD AMF",
        }
    }

    /// The ffmpeg `-c:v` codec name and its quality + pixel-format flags for the
    /// chosen [`QualityTier`]. Kept as one list so the detection probe and the
    /// real export use identical arguments. Only the constant-quality *value*
    /// varies by tier — the flag *shape* is constant, so probing any one tier
    /// (see [`probe`]) validates them all.
    pub fn video_args(self, tier: QualityTier) -> Vec<String> {
        match self {
            Self::X264 => {
                let (crf, preset) = tier.x264();
                vec![
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    preset.into(),
                    "-crf".into(),
                    crf.to_string(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]
            }
            // VideoToolbox: constant-quality mode (`-q:v`, higher is better).
            Self::VideoToolbox => vec![
                "-c:v".into(),
                "h264_videotoolbox".into(),
                "-q:v".into(),
                tier.videotoolbox_q().to_string(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ],
            // NVENC: VBR with a constant-quality target and no bitrate ceiling.
            Self::Nvenc => vec![
                "-c:v".into(),
                "h264_nvenc".into(),
                "-preset".into(),
                "p5".into(),
                "-rc".into(),
                "vbr".into(),
                "-cq".into(),
                tier.nvenc_cq().to_string(),
                "-b:v".into(),
                "0".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ],
            // Quick Sync: ICQ via -global_quality; qsv prefers nv12 input.
            Self::Qsv => vec![
                "-c:v".into(),
                "h264_qsv".into(),
                "-global_quality".into(),
                tier.qsv_gq().to_string(),
                "-pix_fmt".into(),
                "nv12".into(),
            ],
            // AMF: constant QP.
            Self::Amf => {
                let qp = tier.amf_qp().to_string();
                vec![
                    "-c:v".into(),
                    "h264_amf".into(),
                    "-rc".into(),
                    "cqp".into(),
                    "-qp_i".into(),
                    qp.clone(),
                    "-qp_p".into(),
                    qp,
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                ]
            }
        }
    }
}

/// Test-encode 5 frames of a synthetic source with `enc`'s real flags to the
/// null muxer. Returns `true` only if ffmpeg exits successfully.
async fn probe(app: &tauri::AppHandle, enc: VideoEncoder) -> bool {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=256x256:rate=25",
        "-frames:v",
        "5",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    // Probe with the default tier; every tier shares the same flag shape, so this
    // validates the encoder for all of them (only the quality value differs).
    args.extend(enc.video_args(QualityTier::default()));
    args.extend(["-f", "null", "-"].iter().map(|s| (*s).to_string()));

    let Ok(cmd) = app.shell().sidecar("ffmpeg") else {
        return false;
    };
    match cmd.args(args).output().await {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

/// Probe the host's hardware candidates in priority order; return the first that
/// works, or [`VideoEncoder::X264`] if none do. Not cached — see
/// [`detect_cached`].
async fn detect(app: &tauri::AppHandle) -> VideoEncoder {
    for &enc in CANDIDATES {
        if probe(app, enc).await {
            return enc;
        }
    }
    VideoEncoder::X264
}

/// Session cache for the detected hardware encoder, so the (subprocess-spawning)
/// probe runs at most once. Managed by Tauri; see `lib.rs`.
#[derive(Default)]
pub struct EncoderCache(pub tokio::sync::OnceCell<VideoEncoder>);

/// The best available encoder, detecting once and caching for the session.
pub async fn detect_cached(app: &tauri::AppHandle) -> VideoEncoder {
    let cache = app.state::<EncoderCache>();
    *cache.0.get_or_init(|| detect(app)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: whether `args` contains the consecutive pair `[flag, value]`.
    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn x264_high_tier_is_v1_crf18_medium() {
        // High must remain byte-identical to v1's fixed encode.
        let a = VideoEncoder::X264.video_args(QualityTier::High);
        assert_eq!(a[0], "-c:v");
        assert_eq!(a[1], "libx264");
        assert!(has_pair(&a, "-crf", "18"));
        assert!(has_pair(&a, "-preset", "medium"));
    }

    #[test]
    fn x264_tiers_trade_crf_and_preset() {
        let draft = VideoEncoder::X264.video_args(QualityTier::Draft);
        assert!(has_pair(&draft, "-crf", "28"));
        assert!(has_pair(&draft, "-preset", "veryfast"));
        let balanced = VideoEncoder::X264.video_args(QualityTier::Balanced);
        assert!(has_pair(&balanced, "-crf", "23"));
        assert!(has_pair(&balanced, "-preset", "medium"));
    }

    #[test]
    fn lower_tier_means_lower_quality_number_for_hw_cq_encoders() {
        // For the lower-is-better knobs (nvenc -cq, qsv -global_quality, amf -qp),
        // Draft's value is higher (worse/faster) than High's.
        for enc in [VideoEncoder::Nvenc, VideoEncoder::Qsv, VideoEncoder::Amf] {
            let hi = enc.video_args(QualityTier::High);
            let dr = enc.video_args(QualityTier::Draft);
            let num =
                |a: &[String]| -> i32 { a.iter().find_map(|s| s.parse::<i32>().ok()).unwrap() };
            // The first parseable integer is the quality knob for all three.
            assert!(
                num(&dr) > num(&hi),
                "{enc:?}: draft should be a higher qp/cq"
            );
        }
    }

    #[test]
    fn every_encoder_sets_codec_and_pixel_format_for_all_tiers() {
        for tier in [QualityTier::Draft, QualityTier::Balanced, QualityTier::High] {
            for enc in [
                VideoEncoder::X264,
                VideoEncoder::VideoToolbox,
                VideoEncoder::Nvenc,
                VideoEncoder::Qsv,
                VideoEncoder::Amf,
            ] {
                let a = enc.video_args(tier);
                assert_eq!(a[0], "-c:v", "{enc:?} must start with -c:v");
                assert!(
                    a.iter().any(|s| s == "-pix_fmt"),
                    "{enc:?} must set a pixel format"
                );
                assert!(!enc.display_name().is_empty());
            }
        }
    }
}
