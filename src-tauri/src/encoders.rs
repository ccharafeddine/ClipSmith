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

    /// The ffmpeg `-c:v` codec name and its quality + pixel-format flags. Kept
    /// as one list so the detection probe and the real export use identical
    /// arguments. Tuned toward libx264 CRF 18-equivalent quality.
    pub fn video_args(self) -> Vec<&'static str> {
        match self {
            Self::X264 => vec![
                "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            ],
            // VideoToolbox: constant-quality mode (`-q:v`, higher is better).
            Self::VideoToolbox => vec![
                "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p",
            ],
            // NVENC: VBR with a constant-quality target and no bitrate ceiling.
            Self::Nvenc => vec![
                "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0",
                "-pix_fmt", "yuv420p",
            ],
            // Quick Sync: ICQ via -global_quality; qsv prefers nv12 input.
            Self::Qsv => vec![
                "-c:v", "h264_qsv", "-global_quality", "20", "-pix_fmt", "nv12",
            ],
            // AMF: constant QP.
            Self::Amf => vec![
                "-c:v", "h264_amf", "-rc", "cqp", "-qp_i", "20", "-qp_p", "20", "-pix_fmt",
                "yuv420p",
            ],
        }
    }
}

/// Test-encode 5 frames of a synthetic source with `enc`'s real flags to the
/// null muxer. Returns `true` only if ffmpeg exits successfully.
async fn probe(app: &tauri::AppHandle, enc: VideoEncoder) -> bool {
    let mut args: Vec<&str> = vec![
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=256x256:rate=25",
        "-frames:v",
        "5",
    ];
    args.extend(enc.video_args());
    args.extend(["-f", "null", "-"]);

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

    #[test]
    fn x264_is_crf18_libx264() {
        let a = VideoEncoder::X264.video_args();
        assert_eq!(a[0], "-c:v");
        assert_eq!(a[1], "libx264");
        assert!(a.windows(2).any(|w| w == ["-crf", "18"]));
    }

    #[test]
    fn every_encoder_sets_codec_and_pixel_format() {
        for enc in [
            VideoEncoder::X264,
            VideoEncoder::VideoToolbox,
            VideoEncoder::Nvenc,
            VideoEncoder::Qsv,
            VideoEncoder::Amf,
        ] {
            let a = enc.video_args();
            assert_eq!(a[0], "-c:v", "{enc:?} must start with -c:v");
            assert!(a.contains(&"-pix_fmt"), "{enc:?} must set a pixel format");
            assert!(!enc.display_name().is_empty());
        }
    }
}
