//! What an android session needs on its node, each pinned and checked by digest: Google's platform-tools (adb), its
//! emulator and an Android 15 Google APIs system image, scrcpy's server (the live view and the video, scrcpy.rs) and an
//! ffmpeg that decodes its H.264 stream; agent-device comes from npm (agent_device.rs). All of it lives under
//! `<node home>/device/`, with no Java: the node writes the virtual device's files itself rather than run avdmanager.
//!
//! Once installed, the node boots the device cold once, turns its animations off and saves its Quick Boot snapshot
//! (`default_boot`): every session's copy starts from that snapshot with `-read-only`, so nothing it does is kept.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use sha2::Digest as _;

/// The pins, together: a change to any of them installs again, and makes the snapshot again.
pub const PINS: &str = "platform-tools 37.0.1, emulator 37.2.12, android-35 google_apis x86_64 r09, scrcpy 5.0.1, \
                        ffmpeg 6.0.1";

/// scrcpy's server: the node speaks its protocol itself, so the version must match the jar exactly.
pub const SCRCPY_VERSION: &str = "5.0.1";

/// The port of the node's own adb server: never a person's 5037, whose adb may be another version (each would kill
/// the other's server) and whose own devices aren't the agents'.
pub const ADB_SERVER_PORT: u16 = 15037;

/// The virtual device sessions copy.
pub const AVD: &str = "fleetd-android-35";

enum Check {
    Sha1(&'static str),
    Sha256(&'static str),
}

/// One download and where it goes.
struct Package {
    url: &'static str,
    check: Check,
    /// Relative to the device directory; a zip is unpacked into it, a tar into it, a file written as it.
    dest: &'static str,
    unpack: Unpack,
}

#[derive(Clone, Copy, PartialEq)]
enum Unpack {
    Zip,
    TarXz,
    File,
}

const PACKAGES: &[Package] = &[
    Package {
        url: "https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip",
        check: Check::Sha1("477254aa5f903c15cf51001717bdf347fb6b53e0"),
        dest: "sdk",
        unpack: Unpack::Zip,
    },
    Package {
        url: "https://dl.google.com/android/repository/emulator-linux_x64-16428233.zip",
        check: Check::Sha1("cd7362ea55dfb86a418958138dc396e74165dd01"),
        dest: "sdk",
        unpack: Unpack::Zip,
    },
    Package {
        url: "https://dl.google.com/android/repository/sys-img/google_apis/x86_64-35_r09.zip",
        check: Check::Sha1("0103e6dab21290c4b9d16550a3ce99476f884eef"),
        dest: "sdk/system-images/android-35/google_apis",
        unpack: Unpack::Zip,
    },
    Package {
        url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1",
        check: Check::Sha256("764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536"),
        dest: "scrcpy-server.jar",
        unpack: Unpack::File,
    },
    Package {
        url: "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-amd64-static.tar.xz",
        check: Check::Sha256("28268bf402f1083833ea269331587f60a242848880073be8016501d864bd07a5"),
        dest: "ffmpeg",
        unpack: Unpack::TarXz,
    },
];

/// The virtual device's settings: a 720×1600 phone, small enough to stream and record cheaply.
const AVD_CONFIG: &str = "avd.ini.encoding=UTF-8
abi.type=x86_64
hw.cpu.arch=x86_64
hw.cpu.ncore=2
hw.ramSize=2048
hw.lcd.width=720
hw.lcd.height=1600
hw.lcd.density=320
hw.keyboard=yes
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
disk.dataPartition.size=4G
image.sysdir.1=system-images/android-35/google_apis/x86_64/
tag.id=google_apis
target=android-35
PlayStore.enabled=false
fastboot.forceColdBoot=no
fastboot.forceFastBoot=yes
";

/// A cold boot of the image takes about 20 s on a KVM host; this allows a slow one.
const COLD_BOOT: Duration = Duration::from_secs(240);

pub fn device_dir(home: &Path) -> PathBuf {
    home.join("device")
}

/// The node's install, as sessions use it.
#[derive(Clone, Debug, PartialEq)]
pub struct Sdk {
    pub root: PathBuf,
    pub adb: PathBuf,
    pub emulator: PathBuf,
    pub avd_home: PathBuf,
    pub emulator_home: PathBuf,
    pub scrcpy_server: PathBuf,
    pub ffmpeg: PathBuf,
}

impl Sdk {
    pub fn at(home: &Path) -> Self {
        let dir = device_dir(home);
        let root = dir.join("sdk");
        Self {
            adb: root.join("platform-tools/adb"),
            emulator: root.join("emulator/emulator"),
            avd_home: dir.join("avd"),
            emulator_home: dir.join("emulator-home"),
            scrcpy_server: dir.join("scrcpy-server.jar"),
            ffmpeg: dir.join("ffmpeg/ffmpeg-6.0.1-amd64-static/ffmpeg"),
            root,
        }
    }

    /// The environment the emulator and adb run with.
    pub fn env(&self) -> Vec<(&'static str, String)> {
        let lossy = |p: &Path| p.to_string_lossy().into_owned();
        vec![
            ("ANDROID_HOME", lossy(&self.root)),
            ("ANDROID_SDK_ROOT", lossy(&self.root)),
            ("ANDROID_AVD_HOME", lossy(&self.avd_home)),
            ("ANDROID_EMULATOR_HOME", lossy(&self.emulator_home)),
            // The copies' temporary files, which may be large: on disk, not in a /tmp that may be memory.
            ("ANDROID_TMP", lossy(&self.emulator_home.join("tmp"))),
            ("ANDROID_ADB_SERVER_PORT", ADB_SERVER_PORT.to_string()),
        ]
    }

    pub fn adb(&self, serial: &str) -> std::process::Command {
        let mut cmd = std::process::Command::new(&self.adb);
        cmd.arg("-s")
            .arg(serial)
            .envs(self.env())
            .stdin(Stdio::null());
        cmd
    }

    pub fn adb_async(&self, serial: &str) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.adb);
        cmd.arg("-s")
            .arg(serial)
            .envs(self.env())
            .stdin(Stdio::null())
            .kill_on_drop(true);
        cmd
    }
}

/// The marker a finished install leaves: the pins it installed.
fn marker(home: &Path) -> PathBuf {
    device_dir(home).join("INSTALLED")
}

/// The marker the snapshot leaves once saved.
fn snapshot_marker(home: &Path) -> PathBuf {
    device_dir(home).join("SNAPSHOT")
}

/// The install, when it is the pinned one with its snapshot saved.
pub fn find(home: &Path) -> Option<Sdk> {
    let pinned = |path: PathBuf| std::fs::read_to_string(path).is_ok_and(|p| p.trim() == PINS);
    let sdk = Sdk::at(home);
    (pinned(marker(home))
        && pinned(snapshot_marker(home))
        && sdk.adb.is_file()
        && sdk.emulator.is_file()
        && sdk.scrcpy_server.is_file()
        && sdk.ffmpeg.is_file())
    .then_some(sdk)
}

/// Android sessions run on Linux x86_64 with KVM (Google's emulator needs hardware acceleration for an x86_64 image).
pub fn supported() -> bool {
    cfg!(all(target_os = "linux", target_arch = "x86_64"))
}

/// Why this process can't use KVM, with the command that fixes it when a person can; Ok when it can.
pub fn kvm() -> Result<(), (String, Option<String>)> {
    if !supported() {
        return Err((
            "Android screens run only on Linux x86_64 machines with KVM.".to_owned(),
            None,
        ));
    }
    kvm_at(Path::new("/dev/kvm"), Path::new("/etc/group"))
}

fn kvm_at(dev: &Path, group_file: &Path) -> Result<(), (String, Option<String>)> {
    if !dev.exists() {
        return Err((
            "This machine has no /dev/kvm: turn on hardware virtualization (VT-x or AMD-V) in its firmware, or \
             nested virtualization if it is a VM."
                .to_owned(),
            None,
        ));
    }
    // Open it as the emulator will: whatever grants it (a group, an ACL, a udev rule), this is the answer.
    let opened = std::fs::OpenOptions::new().read(true).write(true).open(dev);
    if opened.is_ok() {
        return Ok(());
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "$USER".to_owned());
    let joined = std::fs::read_to_string(group_file).is_ok_and(|groups| {
        groups.lines().any(|line| {
            let mut fields = line.split(':');
            fields.next() == Some("kvm")
                && fields
                    .nth(2)
                    .is_some_and(|members| members.split(',').any(|m| m == user))
        })
    });
    if joined {
        return Err((
            format!(
                "{user} is in group kvm, but fleetd's node started before that: restart the node (or log in \
                 again) so it can use /dev/kvm."
            ),
            None,
        ));
    }
    Err((
        format!(
            "{user} can't open /dev/kvm read-write: add them to group kvm, then restart fleetd's node (an ACL set \
             with setfacl is lost whenever udev makes /dev/kvm again)."
        ),
        Some(format!("sudo usermod -aG kvm {user}")),
    ))
}

/// Installs every pinned piece that isn't, then makes the virtual device and its snapshot. Minutes: about 2 GB comes
/// down, and the device boots cold once.
pub async fn install(home: &Path) -> Result<Sdk, String> {
    if !supported() {
        return Err("Android screens run only on Linux x86_64".to_owned());
    }
    let dir = device_dir(home);
    let installed = std::fs::read_to_string(marker(home)).is_ok_and(|p| p.trim() == PINS);
    if !installed {
        let _ = std::fs::remove_file(snapshot_marker(home));
        for dest in ["sdk", "ffmpeg", "scrcpy-server.jar"] {
            let path = dir.join(dest);
            let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
        }
        let downloads = dir.join("downloads");
        std::fs::create_dir_all(&downloads)
            .map_err(|e| format!("cannot make {}: {e}", downloads.display()))?;
        for package in PACKAGES {
            let file = downloads.join(package.url.rsplit('/').next().unwrap_or("download"));
            download(package, &file).await?;
            let (into, from) = (dir.join(package.dest), file.clone());
            let unpack = package.unpack;
            tokio::task::spawn_blocking(move || unpack_to(&from, &into, unpack))
                .await
                .map_err(|e| e.to_string())??;
            let _ = std::fs::remove_file(&file);
        }
        let _ = std::fs::remove_dir_all(&downloads);
        crate::node::secrets::write_atomic(&marker(home), PINS.as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", marker(home).display()))?;
    }
    let sdk = Sdk::at(home);
    write_avd(&sdk)?;
    snapshot(&sdk).await?;
    crate::node::secrets::write_atomic(&snapshot_marker(home), PINS.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", snapshot_marker(home).display()))?;
    find(home).ok_or_else(|| "the install left something out".to_owned())
}

/// Downloads a package to `file`, checking its digest as it comes.
async fn download(package: &Package, file: &Path) -> Result<(), String> {
    let name = package.url.rsplit('/').next().unwrap_or(package.url);
    let mut response = reqwest::get(package.url)
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("cannot download {name}: {e}"))?;
    let mut out =
        std::fs::File::create(file).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    let (mut sha1, mut sha256) = (
        ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY),
        sha2::Sha256::new(),
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("downloading {name} failed: {e}"))?
    {
        match package.check {
            Check::Sha1(_) => sha1.update(&chunk),
            Check::Sha256(_) => sha2::Digest::update(&mut sha256, &chunk),
        }
        out.write_all(&chunk)
            .map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    }
    let (got, want) = match package.check {
        Check::Sha1(want) => (hex(sha1.finish().as_ref()), want),
        Check::Sha256(want) => (hex(&sha2::Digest::finalize(sha256)), want),
    };
    if got != want {
        let _ = std::fs::remove_file(file);
        return Err(format!("{name} is not the pinned build (digest {got})"));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unpack_to(file: &Path, dest: &Path, unpack: Unpack) -> Result<(), String> {
    let parent = match unpack {
        Unpack::File => dest.parent().unwrap_or(dest),
        _ => dest,
    };
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot make {}: {e}", parent.display()))?;
    let mut cmd = match unpack {
        Unpack::File => {
            return std::fs::rename(file, dest)
                .or_else(|_| std::fs::copy(file, dest).map(|_| ()))
                .map_err(|e| format!("cannot write {}: {e}", dest.display()));
        }
        Unpack::Zip => {
            let mut cmd = std::process::Command::new("unzip");
            cmd.args(["-q", "-o"]).arg(file).arg("-d").arg(dest);
            cmd
        }
        Unpack::TarXz => {
            let mut cmd = std::process::Command::new("tar");
            cmd.arg("-xJf").arg(file).arg("-C").arg(dest);
            cmd
        }
    };
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot unpack {}: {e}", file.display()))?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "unpacking {} failed: {}",
            file.display(),
            said.trim().chars().take(300).collect::<String>()
        ));
    }
    Ok(())
}

/// The virtual device's two files, as avdmanager would write them.
fn write_avd(sdk: &Sdk) -> Result<(), String> {
    let avd_dir = sdk.avd_home.join(format!("{AVD}.avd"));
    std::fs::create_dir_all(&avd_dir)
        .map_err(|e| format!("cannot make {}: {e}", avd_dir.display()))?;
    std::fs::create_dir_all(sdk.emulator_home.join("tmp")).map_err(|e| e.to_string())?;
    let ini = format!(
        "avd.ini.encoding=UTF-8\npath={}\ntarget=android-35\n",
        avd_dir.display()
    );
    std::fs::write(sdk.avd_home.join(format!("{AVD}.ini")), ini).map_err(|e| e.to_string())?;
    let config = avd_dir.join("config.ini");
    let wanted = format!("AvdId={AVD}\navd.ini.displayname={AVD}\n{AVD_CONFIG}");
    if std::fs::read_to_string(&config).ok().as_deref() != Some(wanted.as_str()) {
        // A changed device needs its data and snapshot made again.
        let _ = std::fs::remove_dir_all(&avd_dir);
        std::fs::create_dir_all(&avd_dir).map_err(|e| e.to_string())?;
        std::fs::write(&config, wanted).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Boots the device cold, settles it for automation and quits it, which saves the Quick Boot snapshot copies load.
async fn snapshot(sdk: &Sdk) -> Result<(), String> {
    let port = super::emulator::free_port(&Default::default())
        .ok_or_else(|| "no free emulator port".to_owned())?;
    let serial = format!("emulator-{port}");
    let mut emulator = super::emulator::spawn(sdk, port, false)?;
    let booted = super::emulator::wait_booted(sdk, &serial, &mut emulator, COLD_BOOT).await;
    if let Err(why) = booted {
        emulator.kill();
        return Err(format!("the emulator did not boot: {why}"));
    }
    let settle = [
        "settings put global window_animation_scale 0",
        "settings put global transition_animation_scale 0",
        "settings put global animator_duration_scale 0",
        "settings put global stay_on_while_plugged_in 7",
        "svc power stayon true",
    ];
    for command in settle {
        let _ = sdk
            .adb_async(&serial)
            .arg("shell")
            .arg(command)
            .output()
            .await;
    }
    let _ = sdk.adb_async(&serial).args(["emu", "kill"]).output().await;
    let deadline = Instant::now() + Duration::from_secs(120);
    while emulator.alive() {
        if Instant::now() > deadline {
            emulator.kill();
            return Err("the emulator did not save its snapshot in 2 minutes".to_owned());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let saved = sdk
        .avd_home
        .join(format!("{AVD}.avd/snapshots/default_boot"));
    if !saved.is_dir() {
        return Err("the emulator quit without saving its snapshot".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kvm_says_what_is_wrong_and_how_to_fix_it() {
        let dir = tempfile::tempdir().unwrap();
        let (why, fix) = kvm_at(&dir.path().join("kvm"), &dir.path().join("group")).unwrap_err();
        assert!(why.contains("no /dev/kvm"), "{why}");
        assert_eq!(fix, None);

        // A device this process can't open: one only root may.
        let dev = dir.path().join("kvm");
        std::fs::write(&dev, "").unwrap();
        std::fs::set_permissions(&dev, std::os::unix::fs::PermissionsExt::from_mode(0o000))
            .unwrap();
        if std::fs::File::open(&dev).is_ok() {
            return; // root opens anything
        }
        let user = std::env::var("USER").unwrap_or_else(|_| "$USER".to_owned());
        let group = dir.path().join("group");
        std::fs::write(&group, "kvm:x:992:\n").unwrap();
        let (why, fix) = kvm_at(&dev, &group).unwrap_err();
        assert!(why.contains("add them to group kvm"), "{why}");
        assert_eq!(fix, Some(format!("sudo usermod -aG kvm {user}")));

        std::fs::write(&group, format!("kvm:x:992:other,{user}\n")).unwrap();
        let (why, fix) = kvm_at(&dev, &group).unwrap_err();
        assert!(why.contains("restart the node"), "{why}");
        assert_eq!(fix, None);
    }

    #[test]
    fn nothing_is_found_until_the_pinned_install_and_its_snapshot_are_there() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(find(home.path()), None);
        let sdk = Sdk::at(home.path());
        for file in [&sdk.adb, &sdk.emulator, &sdk.scrcpy_server, &sdk.ffmpeg] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "").unwrap();
        }
        std::fs::write(marker(home.path()), PINS).unwrap();
        assert_eq!(find(home.path()), None, "no snapshot yet");
        std::fs::write(snapshot_marker(home.path()), "an older pin").unwrap();
        assert_eq!(find(home.path()), None, "a snapshot of another install");
        std::fs::write(snapshot_marker(home.path()), PINS).unwrap();
        assert_eq!(find(home.path()), Some(sdk));
    }

    #[test]
    fn the_device_files_name_the_pinned_image() {
        let home = tempfile::tempdir().unwrap();
        let sdk = Sdk::at(home.path());
        write_avd(&sdk).unwrap();
        let ini = std::fs::read_to_string(sdk.avd_home.join(format!("{AVD}.ini"))).unwrap();
        assert!(ini.contains(&format!("{AVD}.avd")));
        let config =
            std::fs::read_to_string(sdk.avd_home.join(format!("{AVD}.avd/config.ini"))).unwrap();
        assert!(config.contains("image.sysdir.1=system-images/android-35/google_apis/x86_64/"));
        assert!(PACKAGES.iter().any(|p| p.url.contains("x86_64-35_r09")));
        // Writing it again keeps what the device holds.
        std::fs::write(sdk.avd_home.join(format!("{AVD}.avd/userdata.img")), "x").unwrap();
        write_avd(&sdk).unwrap();
        assert!(
            sdk.avd_home
                .join(format!("{AVD}.avd/userdata.img"))
                .exists()
        );
    }
}
