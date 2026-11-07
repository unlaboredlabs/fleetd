//! Xcode's `simctl`, on the node's own device set (`xcrun simctl --set <node home>/device/ios/set`): the simulators
//! sessions use live there, apart from a person's own in Xcode, so the node may delete whatever it finds in it. The
//! runtimes and device types are Xcode's, shared by every set.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;

/// A simctl call that hangs (a wedged CoreSimulator) is given up after this; a boot waits longer.
pub const CALL: Duration = Duration::from_secs(60);

/// An iOS runtime Xcode has installed, with the device types it runs.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub identifier: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub is_available: bool,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub supported_device_types: Vec<DeviceType>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceType {
    pub identifier: String,
    pub name: String,
    #[serde(default)]
    pub product_family: Option<String>,
    /// The `.simdevicetype` bundle, whose profile says the screen's scale.
    #[serde(default)]
    pub bundle_path: Option<String>,
}

/// A simulator in the set.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub udid: String,
    pub name: String,
    pub state: String,
}

/// `simctl list runtimes -j`'s iOS runtimes that are available, oldest first as simctl lists them.
pub fn ios_runtimes(json: &str) -> Result<Vec<Runtime>, String> {
    #[derive(Deserialize)]
    struct List {
        runtimes: Vec<Runtime>,
    }
    let list: List =
        serde_json::from_str(json).map_err(|e| format!("simctl's runtimes don't read: {e}"))?;
    Ok(list
        .runtimes
        .into_iter()
        .filter(|r| {
            r.is_available
                && r.platform.as_deref().map_or_else(
                    || r.identifier.contains(".iOS-"),
                    |platform| platform == "iOS",
                )
        })
        .collect())
}

/// `simctl list devices -j`'s simulators, of every runtime.
pub fn devices(json: &str) -> Result<Vec<Device>, String> {
    #[derive(Deserialize)]
    struct List {
        devices: std::collections::BTreeMap<String, Vec<Device>>,
    }
    let list: List =
        serde_json::from_str(json).map_err(|e| format!("simctl's devices don't read: {e}"))?;
    Ok(list.devices.into_values().flatten().collect())
}

/// The runtime and device type sessions use, chosen on purpose across every available iOS runtime: the device type
/// named `wanted` on the newest runtime that has it, else the plain iPhone with the highest number ("iPhone 17", not a
/// Pro, Plus, Max, mini or e; simctl doesn't list them in order) on the newest runtime that runs one. Never whatever
/// type a runtime lists last: Xcode can install a runtime made for one device beside the general one of the same
/// version (`iOS-27-2-iPhone19-4`, which runs only the multi-display "iPhone Duo", where input, alerts and
/// screenshots don't work), and that runtime has no plain iPhone, so it's never picked.
pub fn pick(runtimes: &[Runtime], wanted: Option<&str>) -> Result<(Runtime, DeviceType), String> {
    if runtimes.is_empty() {
        return Err("Xcode has no iOS runtime installed".into());
    }
    let pairs = runtimes
        .iter()
        .flat_map(|r| r.supported_device_types.iter().map(move |t| (r, t)));
    let picked = match wanted {
        Some(wanted) => pairs
            .filter(|(_, t)| t.name == wanted || t.identifier == wanted)
            .max_by(|(a, _), (b, _)| version_key(&a.version).cmp(&version_key(&b.version)))
            .ok_or_else(|| {
                format!(
                    "no iOS runtime has the device type {wanted} (xcrun simctl list devicetypes lists them)"
                )
            })?,
        None => pairs
            .filter_map(|(r, t)| plain_iphone(&t.name).map(|model| ((version_key(&r.version), model), (r, t))))
            .max_by(|(a, _), (b, _)| a.cmp(b))
            .map(|(_, pair)| pair)
            .ok_or("no iOS runtime runs a plain iPhone (\"iPhone 17\"): name a device type in node.json's \
                    \"ios\": {\"deviceType\": ...}")?,
    };
    Ok((picked.0.clone(), picked.1.clone()))
}

/// Whether `name` is the device type [`pick`] chooses when none is named: a plain iPhone.
pub fn is_plain_iphone(name: &str) -> bool {
    plain_iphone(name).is_some()
}

/// A plain iPhone's model number: "iPhone 17" is 17.
fn plain_iphone(name: &str) -> Option<u32> {
    let mut words = name.split_whitespace();
    if words.next() != Some("iPhone") {
        return None;
    }
    let model = words.next()?.parse().ok()?;
    words.next().is_none().then_some(model)
}

fn version_key(version: &str) -> Vec<u32> {
    version.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// `simctl create` and `clone` print the new simulator's udid.
pub fn udid_of(out: &str) -> Option<String> {
    let udid = out.trim();
    (udid.len() == 36 && udid.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .then(|| udid.to_owned())
}

/// The node's simctl, on its device set.
#[derive(Clone, Debug, PartialEq)]
pub struct Simctl {
    pub set: PathBuf,
}

impl Simctl {
    pub fn new(set: PathBuf) -> Self {
        Self { set }
    }

    /// `xcrun simctl --set <set> <args>`.
    pub fn command(&self, args: &[&str]) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("xcrun");
        cmd.arg("simctl")
            .arg("--set")
            .arg(&self.set)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        cmd
    }

    /// The same, blocking: for a simulator thrown away from a drop.
    pub fn blocking(&self, args: &[&str]) -> std::process::Command {
        let mut cmd = std::process::Command::new("xcrun");
        cmd.arg("simctl")
            .arg("--set")
            .arg(&self.set)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    }

    /// Runs a call to its end and returns what it printed; its error says what simctl said.
    pub async fn run(&self, args: &[&str], within: Duration) -> Result<String, String> {
        if let Err(e) = std::fs::create_dir_all(&self.set) {
            return Err(format!("cannot make {}: {e}", self.set.display()));
        }
        let what = args.first().copied().unwrap_or("simctl");
        let out = tokio::time::timeout(within, self.command(args).output())
            .await
            .map_err(|_| format!("simctl {what} did not finish in {} s", within.as_secs()))?
            .map_err(|e| format!("cannot run xcrun simctl: {e}"))?;
        if !out.status.success() {
            let said = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "simctl {what} failed: {}",
                said.trim().chars().take(300).collect::<String>()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub async fn runtimes(&self) -> Result<Vec<Runtime>, String> {
        ios_runtimes(&self.run(&["list", "runtimes", "-j"], CALL).await?)
    }

    pub async fn devices(&self) -> Result<Vec<Device>, String> {
        devices(&self.run(&["list", "devices", "-j"], CALL).await?)
    }

    pub async fn create(
        &self,
        name: &str,
        device_type: &str,
        runtime: &str,
    ) -> Result<String, String> {
        let out = self
            .run(&["create", name, device_type, runtime], CALL)
            .await?;
        udid_of(&out).ok_or_else(|| format!("simctl create printed no udid: {}", out.trim()))
    }

    /// A copy of `source`, which must be shut down.
    pub async fn clone_device(&self, source: &str, name: &str) -> Result<String, String> {
        let out = self.run(&["clone", source, name], CALL).await?;
        udid_of(&out).ok_or_else(|| format!("simctl clone printed no udid: {}", out.trim()))
    }

    /// Boots a simulator and waits until it has finished booting.
    pub async fn boot(&self, udid: &str, within: Duration) -> Result<(), String> {
        self.run(&["boot", udid], CALL).await?;
        self.run(&["bootstatus", udid], within).await.map(drop)
    }

    pub async fn shutdown(&self, udid: &str) -> Result<(), String> {
        match self.run(&["shutdown", udid], CALL).await {
            Ok(_) => Ok(()),
            // Shut down already.
            Err(why) if why.contains("current state: Shutdown") => Ok(()),
            Err(why) => Err(why),
        }
    }

    pub async fn delete(&self, udid: &str) -> Result<(), String> {
        self.run(&["delete", udid], CALL).await.map(drop)
    }

    /// The screen as a JPEG file at `to`, in the device's pixels.
    pub async fn screenshot(&self, udid: &str, to: &Path) -> Result<(), String> {
        let to = to.to_string_lossy();
        self.run(
            &["io", udid, "screenshot", "--type=jpeg", &to],
            Duration::from_secs(10),
        )
        .await
        .map(drop)
    }

    /// The command that records the screen to `to` (H.264 in MP4) until it gets SIGINT. What it says is piped: it says
    /// when it has started (see [`recording_started`]), and its reader drains the rest so the pipe never fills.
    pub fn record(&self, udid: &str, to: &Path) -> tokio::process::Command {
        let to = to.to_string_lossy();
        let mut cmd = self.command(&["io", udid, "recordVideo", "--codec=h264", "--force", &to]);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd
    }
}

/// Whether a line of `recordVideo`'s says it has started recording. A SIGINT before then kills it with no file.
pub fn recording_started(line: &str) -> bool {
    line.to_ascii_lowercase().contains("recording started")
}

/// The screen's scale (3 on today's iPhones) from a device type's profile, which converts the screenshot's pixels to
/// the points agent-device taps at. 3 when the profile doesn't say.
pub async fn scale(device_type: &DeviceType) -> f64 {
    let Some(bundle) = &device_type.bundle_path else {
        return 3.0;
    };
    let profile = Path::new(bundle).join("Contents/Resources/profile.plist");
    let out = tokio::process::Command::new("plutil")
        .args(["-extract", "mainScreenScale", "raw", "-o", "-"])
        .arg(&profile)
        .stdin(Stdio::null())
        .output()
        .await;
    out.ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .filter(|s: &f64| *s >= 1.0)
        .unwrap_or(3.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNTIMES: &str = r#"{ "runtimes": [
        { "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-2", "name": "iOS 26.2", "version": "26.2",
          "isAvailable": true, "platform": "iOS",
          "supportedDeviceTypes": [ { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17", "name": "iPhone 17",
                                      "productFamily": "iPhone" } ] },
        { "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-27-0", "name": "iOS 27.0", "version": "27.0",
          "isAvailable": true, "platform": "iOS",
          "supportedDeviceTypes": [
            { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17", "name": "iPhone 17", "productFamily": "iPhone",
              "bundlePath": "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17.simdevicetype" },
            { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", "name": "iPhone 18 Pro", "productFamily": "iPhone" },
            { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-18", "name": "iPhone 18", "productFamily": "iPhone" },
            { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-11", "name": "iPhone 11", "productFamily": "iPhone" },
            { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11", "name": "iPad Air 11-inch", "productFamily": "iPad" }
          ] },
        { "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-28-0", "name": "iOS 28.0", "version": "28.0",
          "isAvailable": false, "platform": "iOS", "supportedDeviceTypes": [] },
        { "identifier": "com.apple.CoreSimulator.SimRuntime.watchOS-12-0", "name": "watchOS 12.0", "version": "12.0",
          "isAvailable": true, "platform": "watchOS", "supportedDeviceTypes": [] }
    ] }"#;

    #[test]
    fn sessions_use_the_newest_available_ios_and_its_newest_plain_iphone() {
        let runtimes = ios_runtimes(RUNTIMES).unwrap();
        assert_eq!(runtimes.len(), 2, "not one that's unavailable, nor watchOS");
        let (runtime, device_type) = pick(&runtimes, None).unwrap();
        assert_eq!(runtime.name, "iOS 27.0");
        assert_eq!(device_type.name, "iPhone 18");
        let (_, wanted) = pick(&runtimes, Some("iPhone 18 Pro")).unwrap();
        assert_eq!(
            wanted.identifier,
            "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"
        );
        assert!(
            pick(&runtimes, Some("Pixel 9"))
                .unwrap_err()
                .contains("no iOS runtime has the device type Pixel 9")
        );
        // A type only an older runtime has: on that one.
        let (runtime, ipad) = pick(&runtimes, Some("iPad Air 11-inch")).unwrap();
        assert_eq!(
            (runtime.name.as_str(), ipad.name.as_str()),
            ("iOS 27.0", "iPad Air 11-inch")
        );
        assert!(pick(&[], None).unwrap_err().contains("no iOS runtime"));
    }

    /// The agents' Mac had iOS 27.2 twice: the general runtime and one made for the "iPhone Duo" alone, listed last.
    /// Taking the newest runtime's last iPhone gave every agent a multi-display Duo, where input didn't land.
    #[test]
    fn a_runtime_made_for_one_device_never_gives_the_golden_its_device() {
        let runtimes = ios_runtimes(
            r#"{ "runtimes": [
            { "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-27-2", "name": "iOS 27.2", "version": "27.2",
              "isAvailable": true, "platform": "iOS",
              "supportedDeviceTypes": [
                { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17", "name": "iPhone 17", "productFamily": "iPhone" },
                { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "name": "iPhone 17 Pro", "productFamily": "iPhone" }
              ] },
            { "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4", "name": "iOS 27.2", "version": "27.2",
              "isAvailable": true, "platform": "iOS",
              "supportedDeviceTypes": [
                { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo", "name": "iPhone Duo", "productFamily": "iPhone" }
              ] }
        ] }"#,
        )
        .unwrap();
        let (runtime, device_type) = pick(&runtimes, None).unwrap();
        assert_eq!(
            runtime.identifier,
            "com.apple.CoreSimulator.SimRuntime.iOS-27-2"
        );
        assert_eq!(device_type.name, "iPhone 17");
        // Asked for by name, it's there.
        let (runtime, duo) = pick(&runtimes, Some("iPhone Duo")).unwrap();
        assert_eq!(
            (runtime.identifier.as_str(), duo.name.as_str()),
            (
                "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4",
                "iPhone Duo"
            )
        );
        // Only the Duo's runtime: no plain iPhone, and it says how to name one rather than taking the Duo.
        assert!(
            pick(&runtimes[1..], None)
                .unwrap_err()
                .contains("no iOS runtime runs a plain iPhone")
        );
    }

    #[test]
    fn plain_iphones_are_a_number_and_nothing_after() {
        assert_eq!(plain_iphone("iPhone 17"), Some(17));
        for not in ["iPhone 17 Pro", "iPhone 16e", "iPhone Air", "iPad 11"] {
            assert_eq!(plain_iphone(not), None, "{not}");
        }
    }

    #[test]
    fn devices_of_every_runtime_and_new_udids_read() {
        let list = devices(
            r#"{ "devices": {
                "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                    { "udid": "8A1B2C3D-0000-4000-8000-000000000001", "name": "fleetd-golden", "state": "Shutdown",
                      "isAvailable": true },
                    { "udid": "8A1B2C3D-0000-4000-8000-000000000002", "name": "fleetd-3f9a", "state": "Booted" }
                ],
                "com.apple.CoreSimulator.SimRuntime.iOS-26-2": []
            } }"#,
        )
        .unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].state, "Booted");
        assert_eq!(
            udid_of("8A1B2C3D-0000-4000-8000-000000000002\n").as_deref(),
            Some("8A1B2C3D-0000-4000-8000-000000000002")
        );
        assert_eq!(udid_of("Invalid device type: iPhone 99"), None);
    }

    #[test]
    fn record_video_says_when_it_has_started() {
        assert!(recording_started("Recording started"));
        assert!(recording_started("2026-10-27 02:08:15 Recording started."));
        assert!(!recording_started("Recording to /r/video.mp4"));
    }

    #[test]
    fn every_call_is_on_the_nodes_own_set() {
        let simctl = Simctl::new(PathBuf::from("/n/device/ios/set"));
        let cmd = simctl.record("U1", Path::new("/r/video.mp4"));
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "simctl",
                "--set",
                "/n/device/ios/set",
                "io",
                "U1",
                "recordVideo",
                "--codec=h264",
                "--force",
                "/r/video.mp4"
            ]
        );
    }
}
