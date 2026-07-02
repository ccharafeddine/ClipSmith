//! Output format selection (v2): ClipSmith exports MP4 by default, but can also
//! write MOV, MKV, or WebM — a built-in container/codec converter.
//!
//! The reframe filtergraph and the trim are codec-agnostic (they hand off
//! `yuv420p` frames), so the only thing a format changes is the tail of the
//! ffmpeg command: the video codec, the audio codec, and the container/muxer.
//!
//! Two families:
//! - **H.264 containers** (MP4 / MOV / MKV) — H.264 video + AAC audio. These
//!   reuse the whole existing pipeline, including the [`VideoEncoder`] choice
//!   (libx264 or a detected hardware encoder). Always available, since libx264
//!   ships with the app.
//! - **WebM** — VP9 video + Opus audio. A genuinely different codec path (no
//!   hardware H.264 encoder applies; VP9 is software `libvpx-vp9`). It needs
//!   `libvpx`/`libopus` in the bundled ffmpeg, which isn't guaranteed on every
//!   build, so WebM is offered only when a runtime probe confirms it encodes.
//!
//! WebM works on both platforms: the Windows GPL ffmpeg (BtbN) bundles libvpx +
//! libopus, and `scripts/build-ffmpeg-macos.sh` compiles static libvpx + libopus
//! into the macOS sidecar. The runtime probe still gates WebM, so if a future
//! build ever drops those libs, WebM self-hides rather than failing at export.

use tauri::Manager;
use tauri_plugin_shell::ShellExt;

use crate::encoders::VideoEncoder;

/// An output container + its codecs. `id()` doubles as the file extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Mp4,
    Mov,
    Mkv,
    Webm,
}

impl OutputFormat {
    /// Parse the frontend's format id (also the file extension).
    pub fn from_id(s: &str) -> Option<Self> {
        match s {
            "mp4" => Some(Self::Mp4),
            "mov" => Some(Self::Mov),
            "mkv" => Some(Self::Mkv),
            "webm" => Some(Self::Webm),
            _ => None,
        }
    }

    /// The format id / file extension (`"mp4"`, `"mov"`, `"mkv"`, `"webm"`).
    pub fn id(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Mkv => "mkv",
            Self::Webm => "webm",
        }
    }

    /// Whether this format uses H.264 video (so the [`VideoEncoder`] choice — and
    /// hardware acceleration — applies). WebM uses VP9 instead.
    pub fn uses_h264(self) -> bool {
        matches!(self, Self::Mp4 | Self::Mov | Self::Mkv)
    }

    /// The ffmpeg muxer name for `-f` (forced so a renamed output can't confuse
    /// container detection).
    fn muxer(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Mkv => "matroska",
            Self::Webm => "webm",
        }
    }

    /// Video codec + quality args. H.264 formats defer to the chosen encoder
    /// (libx264 or hardware); WebM uses constant-quality VP9. `-pix_fmt yuv420p`
    /// keeps every target broadly compatible.
    pub fn video_args(self, encoder: VideoEncoder) -> Vec<String> {
        if self.uses_h264() {
            return encoder
                .video_args()
                .iter()
                .map(|s| (*s).to_string())
                .collect();
        }
        // WebM: VP9 in constant-quality mode (`-b:v 0` + `-crf`). `good`/cpu-used
        // 2 and row multithreading trade a little speed for quality; VP9 software
        // is inherently slower than H.264.
        [
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            "31",
            "-deadline",
            "good",
            "-cpu-used",
            "2",
            "-row-mt",
            "1",
            "-pix_fmt",
            "yuv420p",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect()
    }

    /// Audio codec args: AAC for H.264 containers, Opus for WebM.
    fn audio_args(self) -> &'static [&'static str] {
        if self.uses_h264() {
            &["-c:a", "aac", "-b:a", "192k"]
        } else {
            &["-c:a", "libopus", "-b:a", "128k"]
        }
    }

    /// Container-specific flags. `+faststart` only helps the mp4/mov muxers.
    fn container_args(self) -> &'static [&'static str] {
        match self {
            Self::Mp4 | Self::Mov => &["-movflags", "+faststart"],
            Self::Mkv | Self::Webm => &[],
        }
    }

    /// The full tail of the ffmpeg command: video, audio, container flags, muxer,
    /// and the output path. `encoder` is ignored for non-H.264 formats.
    pub fn encode_args(self, encoder: VideoEncoder, output: &str) -> Vec<String> {
        let mut args = self.video_args(encoder);
        args.extend(self.audio_args().iter().map(|s| (*s).to_string()));
        args.extend(self.container_args().iter().map(|s| (*s).to_string()));
        args.extend(
            [
                "-avoid_negative_ts",
                "make_zero",
                "-f",
                self.muxer(),
                "-y",
                output,
            ]
            .iter()
            .map(|s| (*s).to_string()),
        );
        args
    }
}

/// Session cache for the list of formats the bundled ffmpeg can actually
/// produce. Managed by Tauri; see `lib.rs`.
#[derive(Default)]
pub struct FormatCache(pub tokio::sync::OnceCell<Vec<OutputFormat>>);

/// Test-encode a few frames of VP9 + Opus to confirm the bundled ffmpeg has
/// `libvpx`/`libopus`. Fast settings — this only checks availability.
async fn probe_webm(app: &tauri::AppHandle) -> bool {
    let args = [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=128x128:rate=15",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440",
        "-shortest",
        "-frames:v",
        "3",
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "40",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        "-f",
        "null",
        "-",
    ];
    let Ok(cmd) = app.shell().sidecar("ffmpeg") else {
        return false;
    };
    matches!(cmd.args(args).output().await, Ok(o) if o.status.success())
}

/// The formats the bundled ffmpeg can produce, detecting once and caching for
/// the session. MP4/MOV/MKV (H.264) are always available; WebM is added only if
/// the VP9/Opus probe succeeds.
pub async fn available_cached(app: &tauri::AppHandle) -> Vec<OutputFormat> {
    let cache = app.state::<FormatCache>();
    cache
        .0
        .get_or_init(|| async {
            let mut formats = vec![OutputFormat::Mp4, OutputFormat::Mov, OutputFormat::Mkv];
            if probe_webm(app).await {
                formats.push(OutputFormat::Webm);
            }
            formats
        })
        .await
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip() {
        for id in ["mp4", "mov", "mkv", "webm"] {
            assert_eq!(OutputFormat::from_id(id).unwrap().id(), id);
        }
        assert!(OutputFormat::from_id("gif").is_none());
    }

    #[test]
    fn h264_formats_use_the_encoder_and_aac() {
        let args = OutputFormat::Mkv.encode_args(VideoEncoder::X264, "out.mkv");
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert!(args.windows(2).any(|w| w == ["-f", "matroska"]));
        // No faststart for mkv.
        assert!(!args.iter().any(|a| a == "+faststart"));
    }

    #[test]
    fn mp4_gets_faststart() {
        let args = OutputFormat::Mp4.encode_args(VideoEncoder::X264, "out.mp4");
        assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
        assert!(args.windows(2).any(|w| w == ["-f", "mp4"]));
    }

    #[test]
    fn webm_uses_vp9_opus_regardless_of_encoder() {
        // Even if a hardware H.264 encoder is passed, WebM stays VP9/Opus.
        let args = OutputFormat::Webm.encode_args(VideoEncoder::Nvenc, "out.webm");
        assert!(args.windows(2).any(|w| w == ["-c:v", "libvpx-vp9"]));
        assert!(args.windows(2).any(|w| w == ["-c:a", "libopus"]));
        assert!(args.windows(2).any(|w| w == ["-f", "webm"]));
        assert!(!args.iter().any(|a| a == "libx264" || a == "h264_nvenc"));
    }
}
