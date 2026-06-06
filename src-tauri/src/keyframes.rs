//! Parse `ffprobe -show_entries packet=pts_time,flags` JSON into a sorted list
//! of keyframe timestamps (seconds).
//!
//! A packet is a keyframe when its `flags` string contains `K` (ffprobe renders
//! flags as e.g. `K__`). These timestamps drive the magnetic IN handle: the cut
//! can only start cleanly on a keyframe under `-c copy`.

use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum KeyframeError {
    #[error("could not parse ffprobe output as JSON: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Deserialize)]
struct PacketList {
    #[serde(default)]
    packets: Vec<Packet>,
}

#[derive(Deserialize)]
struct Packet {
    pts_time: Option<String>,
    flags: Option<String>,
}

/// Parse the packet JSON and return sorted, de-duplicated keyframe timestamps.
///
/// `0.0` is always present and first: the opening frame is by definition a
/// keyframe, and the IN-snap fallback relies on at least one being available.
///
/// # Errors
/// Returns [`KeyframeError::Json`] if the document is not valid JSON.
pub fn parse_keyframes(json: &str) -> Result<Vec<f64>, KeyframeError> {
    let list: PacketList = serde_json::from_str(json)?;

    let mut times: Vec<f64> = list
        .packets
        .iter()
        .filter(|p| p.flags.as_deref().is_some_and(|f| f.contains('K')))
        .filter_map(|p| p.pts_time.as_deref())
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect();

    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    times.dedup();

    // Guarantee a usable IN-snap target even on odd inputs.
    if times.first().is_none_or(|&first| first > 0.0) {
        times.insert(0, 0.0);
    }

    Ok(times)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn keeps_only_k_flagged_packets() {
        let json = r#"{
            "packets": [
                {"pts_time": "0.000000", "flags": "K__"},
                {"pts_time": "0.033333", "flags": "___"},
                {"pts_time": "2.000000", "flags": "K__"},
                {"pts_time": "2.033333", "flags": "___"}
            ]
        }"#;
        let kfs = parse_keyframes(json).unwrap();
        assert!(approx_eq(&kfs, &[0.0, 2.0]), "got {kfs:?}");
    }

    #[test]
    fn sorts_and_dedups_out_of_order_packets() {
        // B-frame reordering can emit packets out of presentation order.
        let json = r#"{
            "packets": [
                {"pts_time": "4.0", "flags": "K_"},
                {"pts_time": "0.0", "flags": "K_"},
                {"pts_time": "2.0", "flags": "K_"},
                {"pts_time": "2.0", "flags": "K_"}
            ]
        }"#;
        let kfs = parse_keyframes(json).unwrap();
        assert!(approx_eq(&kfs, &[0.0, 2.0, 4.0]), "got {kfs:?}");
    }

    #[test]
    fn skips_unparseable_timestamps() {
        let json = r#"{
            "packets": [
                {"pts_time": "0.0", "flags": "K_"},
                {"pts_time": "N/A", "flags": "K_"},
                {"flags": "K_"}
            ]
        }"#;
        let kfs = parse_keyframes(json).unwrap();
        assert!(approx_eq(&kfs, &[0.0]), "got {kfs:?}");
    }

    #[test]
    fn prepends_zero_when_first_keyframe_is_later() {
        let json = r#"{"packets": [{"pts_time": "1.5", "flags": "K_"}]}"#;
        let kfs = parse_keyframes(json).unwrap();
        assert!(approx_eq(&kfs, &[0.0, 1.5]), "got {kfs:?}");
    }

    #[test]
    fn returns_zero_for_empty_packet_list() {
        let kfs = parse_keyframes(r#"{"packets": []}"#).unwrap();
        assert!(approx_eq(&kfs, &[0.0]), "got {kfs:?}");
    }

    #[test]
    fn errors_on_malformed_json() {
        assert!(matches!(
            parse_keyframes("nope"),
            Err(KeyframeError::Json(_))
        ));
    }
}
