//! Parse `ffprobe -show_streams -show_format` JSON into a small, typed
//! [`VideoMeta`] the frontend can consume.
//!
//! `container` is intentionally derived from the source file extension rather
//! than from ffprobe's `format_name` (which is a comma list like
//! `mov,mp4,m4a,3gp,3g2,mj2`). ClipSmith's lossless cut writes the output with
//! the *same extension as the source*, so the extension is the honest source of
//! truth for the container we will mux back into.

use serde::{Deserialize, Serialize};

/// Metadata about the loaded video, sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VideoMeta {
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub codec: String,
    pub container: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("could not parse ffprobe output as JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("no video stream found in file")]
    NoVideoStream,
    #[error("could not determine video duration")]
    NoDuration,
}

#[derive(Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

/// Parse an ffprobe JSON document plus the source file extension into a
/// [`VideoMeta`]. `ext` is the lowercased extension without a leading dot
/// (e.g. `"mp4"`); it becomes [`VideoMeta::container`].
///
/// # Errors
/// Returns [`ProbeError`] if the JSON is malformed, has no video stream, or
/// has no determinable duration.
pub fn parse_meta(json: &str, ext: &str) -> Result<VideoMeta, ProbeError> {
    let probe: FfprobeOutput = serde_json::from_str(json)?;

    let video = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .ok_or(ProbeError::NoVideoStream)?;

    // Duration: prefer the container-level value, fall back to the stream's.
    let duration_secs = probe
        .format
        .as_ref()
        .and_then(|f| f.duration.as_deref())
        .or(video.duration.as_deref())
        .and_then(parse_f64)
        .ok_or(ProbeError::NoDuration)?;

    // Frame rate: r_frame_rate is the base (true) rate; avg_frame_rate is the
    // fallback. Both look like "30/1". Unknown rates report as 0/1.
    let (fps_num, fps_den) = video
        .r_frame_rate
        .as_deref()
        .and_then(parse_rational)
        .or_else(|| video.avg_frame_rate.as_deref().and_then(parse_rational))
        .unwrap_or((0, 1));

    Ok(VideoMeta {
        duration_secs,
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        fps_num,
        fps_den,
        codec: video.codec_name.clone().unwrap_or_default(),
        container: ext.to_string(),
    })
}

fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse().ok()
}

/// Parse an ffprobe rational like `"30/1"`. Rejects a zero denominator (and
/// the `"0/0"` ffprobe emits for rates it cannot determine).
fn parse_rational(s: &str) -> Option<(u32, u32)> {
    let (num, den) = s.split_once('/')?;
    let num: u32 = num.trim().parse().ok()?;
    let den: u32 = den.trim().parse().ok()?;
    if den == 0 {
        return None;
    }
    Some((num, den))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed but structurally faithful to real ffprobe output (an mp4 with an
    // h264 video stream followed by an aac audio stream).
    const SAMPLE: &str = r#"{
        "streams": [
            {
                "index": 0,
                "codec_name": "h264",
                "codec_type": "video",
                "width": 640,
                "height": 480,
                "r_frame_rate": "30/1",
                "avg_frame_rate": "30/1",
                "duration": "3.000000"
            },
            {
                "index": 1,
                "codec_name": "aac",
                "codec_type": "audio",
                "r_frame_rate": "0/0",
                "avg_frame_rate": "0/0",
                "duration": "3.000000"
            }
        ],
        "format": {
            "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
            "duration": "3.000000"
        }
    }"#;

    #[test]
    fn parses_real_sample() {
        let meta = parse_meta(SAMPLE, "mp4").expect("should parse");
        assert_eq!(
            meta,
            VideoMeta {
                duration_secs: 3.0,
                width: 640,
                height: 480,
                fps_num: 30,
                fps_den: 1,
                codec: "h264".to_string(),
                container: "mp4".to_string(),
            }
        );
    }

    #[test]
    fn picks_video_stream_not_audio() {
        // Audio stream comes first; we must still report the video's dimensions.
        let json = r#"{
            "streams": [
                {"codec_type": "audio", "codec_name": "aac"},
                {"codec_type": "video", "codec_name": "vp9", "width": 1920,
                 "height": 1080, "r_frame_rate": "24/1", "duration": "5.0"}
            ],
            "format": {"duration": "5.0"}
        }"#;
        let meta = parse_meta(json, "webm").unwrap();
        assert_eq!(meta.width, 1920);
        assert_eq!(meta.height, 1080);
        assert_eq!(meta.codec, "vp9");
        assert_eq!((meta.fps_num, meta.fps_den), (24, 1));
        assert_eq!(meta.container, "webm");
    }

    #[test]
    fn falls_back_to_stream_duration_when_format_missing() {
        let json = r#"{
            "streams": [{"codec_type": "video", "width": 10, "height": 10,
                         "r_frame_rate": "25/1", "duration": "7.5"}]
        }"#;
        let meta = parse_meta(json, "mkv").unwrap();
        assert!((meta.duration_secs - 7.5).abs() < f64::EPSILON);
    }

    #[test]
    fn falls_back_to_avg_frame_rate_when_r_is_zero() {
        let json = r#"{
            "streams": [{"codec_type": "video", "width": 10, "height": 10,
                         "r_frame_rate": "0/0", "avg_frame_rate": "60/1",
                         "duration": "1.0"}],
            "format": {"duration": "1.0"}
        }"#;
        let meta = parse_meta(json, "mp4").unwrap();
        assert_eq!((meta.fps_num, meta.fps_den), (60, 1));
    }

    #[test]
    fn errors_without_video_stream() {
        let json = r#"{"streams": [{"codec_type": "audio"}], "format": {"duration": "1.0"}}"#;
        assert!(matches!(
            parse_meta(json, "mp3"),
            Err(ProbeError::NoVideoStream)
        ));
    }

    #[test]
    fn errors_on_malformed_json() {
        assert!(matches!(parse_meta("not json", "mp4"), Err(ProbeError::Json(_))));
    }
}
