//! In-app update check. Queries the GitHub Releases API for the latest tag and
//! compares it against the compiled-in crate version.
//!
//! The network call lives here in Rust, not the webview: the frontend calls
//! `check_for_update` and only renders the result. This is **prompt-only** —
//! ClipSmith never downloads or installs an update itself; on an available
//! update the frontend opens the release page so the user gets the installer.

use serde::Serialize;

/// The GitHub repository ClipSmith releases are published to. Matches the slug
/// in `.github/workflows/release.yml` and the `origin` git remote.
const REPO: &str = "ccharafeddine/ClipSmith";

/// The result of an update check, returned to the frontend (camelCase for JS).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// The running version (compiled-in `CARGO_PKG_VERSION`), e.g. `"1.0.0"`.
    pub current: String,
    /// The latest published release tag, normalized without a leading `v`.
    pub latest: String,
    /// Whether `latest` is strictly newer than `current`.
    pub is_newer: bool,
    /// The release notes (the GitHub release body); may be empty.
    pub notes: String,
    /// The release page URL to open for the download.
    pub url: String,
}

/// Parse a version string (`"v1.2.3"`, `"1.2"`, `"1.2.0-beta.1"`) into a numeric
/// `(major, minor, patch)` tuple for comparison. Each dot-separated segment
/// contributes its leading digits; any non-numeric suffix (a pre-release tag) is
/// ignored, and missing segments read as `0`, so `"1.2" == "1.2.0"`.
fn version_tuple(v: &str) -> (u64, u64, u64) {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let mut parts = v.split('.').map(|seg| {
        let digits: String = seg.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<u64>().unwrap_or(0)
    });
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// Whether `latest` is a strictly newer version than `current`.
fn is_newer(current: &str, latest: &str) -> bool {
    version_tuple(latest) > version_tuple(current)
}

/// The minimal shape of the GitHub "latest release" response we consume.
#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
}

/// Check GitHub Releases for a newer ClipSmith and return the comparison.
///
/// Performs one GET to the GitHub API with a `User-Agent` (GitHub requires one)
/// and the recommended `Accept` header, reusing the same reqwest/native-tls
/// client stack as URL import. Note the API's `releases/latest` skips drafts and
/// pre-releases, so this only ever reports a published release. This never
/// downloads or installs anything.
///
/// # Errors
/// Returns a user-facing message if the request fails or the response can't be
/// parsed.
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");

    let resp = reqwest::Client::new()
        .get(&url)
        .header(
            reqwest::header::USER_AGENT,
            concat!("ClipSmith/", env!("CARGO_PKG_VERSION")),
        )
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| {
            "Couldn't reach GitHub to check for updates. Check your connection.".to_string()
        })?;

    if !resp.status().is_success() {
        return Err(format!(
            "GitHub returned {} while checking for updates.",
            resp.status()
        ));
    }

    let text = resp
        .text()
        .await
        .map_err(|_| "The update response was interrupted.".to_string())?;
    let release: GithubRelease = serde_json::from_str(&text)
        .map_err(|_| "Couldn't read the update information from GitHub.".to_string())?;

    let latest = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let newer = is_newer(&current, &latest);

    Ok(UpdateInfo {
        current,
        latest,
        is_newer: newer,
        notes: release.body.unwrap_or_default(),
        url: release
            .html_url
            .unwrap_or_else(|| format!("https://github.com/{REPO}/releases/latest")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_tuple_parses_and_normalizes() {
        assert_eq!(version_tuple("1.2.3"), (1, 2, 3));
        assert_eq!(version_tuple("v1.2.3"), (1, 2, 3));
        assert_eq!(version_tuple("V2.0.0"), (2, 0, 0));
        // Missing segments read as zero.
        assert_eq!(version_tuple("1.2"), (1, 2, 0));
        assert_eq!(version_tuple("3"), (3, 0, 0));
        // Pre-release suffixes are ignored per segment.
        assert_eq!(version_tuple("1.2.0-beta.1"), (1, 2, 0));
        assert_eq!(version_tuple("1.4.0-rc2"), (1, 4, 0));
        // Garbage degrades to zeros rather than panicking.
        assert_eq!(version_tuple(""), (0, 0, 0));
        assert_eq!(version_tuple("not.a.version"), (0, 0, 0));
    }

    #[test]
    fn is_newer_compares_numerically() {
        assert!(is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("1.0.0", "1.1.0"));
        assert!(is_newer("1.9.0", "2.0.0"));
        // A leading `v` on either side doesn't matter.
        assert!(is_newer("1.0.0", "v1.0.1"));
        // Not newer: equal or older.
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("2.0.0", "1.9.9"));
        assert!(!is_newer("1.2.0", "1.2.0-beta"));
        // Numeric, not lexicographic: 10 > 9.
        assert!(is_newer("1.9.0", "1.10.0"));
    }
}
