//! The macOS half of `FLEETD_RECORD` (app/fleetd-app/src/record.rs): the app records its own window, native titlebar
//! and traffic lights included, to `<dir>/fleetd.mp4` (H.264, 4:2:0, moov atom first) and keeps a PNG of it every
//! 2 s in `<dir>/frames/`. A crate of its own because it is all FFI and the workspace forbids unsafe code.
//!
//! The window server hands an app images of its own windows without the Screen Recording permission, so
//! `CGWindowListCreateImage` on our window number needs no prompt; the start line says whether the process holds
//! that permission anyway (`screen_capture_access=`), which is how a CI run tells the two apart. AVAssetWriter
//! encodes on the hardware encoder, so a Retina-size window records in real time with no ffmpeg.
//!
//! A capture thread grabs the window at a fixed rate and stamps each frame with its capture time, so a slow frame
//! makes the video skip, never drift. SIGTERM, SIGINT and quitting the app all finish the file before the process
//! exits; a run killed outright leaves an unplayable MP4 but keeps its PNGs.
#![cfg(target_os = "macos")]

use std::ffi::{CString, c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{Encode, Encoding, RefEncode, class, msg_send};
use raw_window_handle::{RawWindowHandle, WindowHandle};

/// Set by a signal or by quitting; the capture thread finishes the file when it sees it.
static STOP: AtomicBool = AtomicBool::new(false);
/// Set by `finish` before STOP, so the thread leaves exiting to the app.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// Set once the file is finished (or recording failed), so `finish` knows when the app may go on quitting.
static DONE: AtomicBool = AtomicBool::new(false);
const PNG_EVERY: Duration = Duration::from_secs(2);

/// The CGWindowID of an AppKit window handle. Call on the main thread.
pub fn window_number(handle: WindowHandle<'_>) -> Option<u32> {
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else { return None };
    let view = handle.ns_view.as_ptr().cast::<AnyObject>();
    // SAFETY: the handle borrows a live NSView; -window and -windowNumber have these types.
    unsafe {
        let ns_window: *mut AnyObject = msg_send![view, window];
        if ns_window.is_null() {
            return None;
        }
        let number: isize = msg_send![ns_window, windowNumber];
        u32::try_from(number).ok().filter(|n| *n > 0)
    }
}

/// Starts recording window `window` into `dir` at `fps`, until a signal (which then exits the process) or `finish`.
pub fn start(window: u32, dir: PathBuf, fps: u32) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join("frames"))?;
    hold_off_app_nap();
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
    }
    std::thread::Builder::new().name("fleetd-record".into()).spawn(move || {
        // A frame is due every few tens of ms; don't let the scheduler treat this thread as background work.
        // SAFETY: sets this thread's own QoS class.
        unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0) };
        let signalled = run(window, &dir, fps);
        DONE.store(true, Ordering::SeqCst);
        // A signal ends the process once the file is whole; a quit is already on its way out.
        if signalled {
            std::process::exit(0);
        }
    })?;
    Ok(())
}

/// macOS coalesces the timers of an app it considers idle (App Nap), which would stretch the capture thread's
/// sleeps. A latency-critical activity, held until the process exits, keeps it on time.
fn hold_off_app_nap() {
    const USER_INITIATED: u64 = 0x00FF_FFFF;
    const LATENCY_CRITICAL: u64 = 0xFF_0000_0000;
    // SAFETY: -beginActivityWithOptions:reason: returns a token object; it is retained here and never released,
    // so the activity lasts as long as the process.
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let reason: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c"fleetd is recording its window".as_ptr()];
        let token: *mut AnyObject = msg_send![info, beginActivityWithOptions: USER_INITIATED | LATENCY_CRITICAL, reason: reason];
        let _: *mut AnyObject = msg_send![token, retain];
    }
}

/// Stops recording and waits up to `timeout` for the file to be finished. For the app's quit.
pub fn finish(timeout: Duration) {
    QUITTING.store(true, Ordering::SeqCst);
    STOP.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + timeout;
    while !DONE.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

extern "C" fn on_signal(_: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

/// Captures until STOP; returns whether a signal (not a quit) stopped it.
fn run(window: u32, dir: &Path, fps: u32) -> bool {
    let mp4 = dir.join("fleetd.mp4");
    let _ = std::fs::remove_file(&mp4);
    // SAFETY: a plain query.
    let access = unsafe { CGPreflightScreenCaptureAccess() };
    eprintln!("FLEETD_RECORD start window={window} fps={} screen_capture_access={access} out={}", fps, mp4.display());
    let interval = Duration::from_secs_f64(1.0 / f64::from(fps));
    let started = Instant::now();
    let mut writer: Option<Writer> = None;
    let mut failed = false;
    let (mut frames, mut skipped, mut pngs) = (0u64, 0u64, 0u32);
    // Time spent in the window server's capture and in drawing + appending, to tell which one limits the rate.
    let (mut grab, mut encode) = (Duration::ZERO, Duration::ZERO);
    // Ticks run, and ticks that started late (the previous one overran or the sleep overslept).
    let (mut ticks, mut late) = (0u64, 0u64);
    let (mut busy, mut slept) = (Duration::ZERO, Duration::ZERO);
    let mut next_png = Duration::ZERO;
    let mut tick = started;
    while !STOP.load(Ordering::SeqCst) && !failed {
        let body = Instant::now();
        autoreleasepool(|_| {
            let t = Instant::now();
            let Some(image) = capture(window) else { return };
            grab += t.elapsed();
            let at = started.elapsed();
            if at >= next_png {
                write_png(&image, &dir.join("frames").join(format!("frame-{:06.1}s.png", at.as_secs_f64())));
                pngs += 1;
                next_png += PNG_EVERY;
            }
            if writer.is_none() {
                match Writer::new(&mp4, image.width(), image.height(), fps) {
                    Ok(w) => writer = Some(w),
                    Err(e) => {
                        eprintln!("FLEETD_RECORD error={e}");
                        failed = true;
                        return;
                    }
                }
            }
            if let Some(w) = &writer {
                let t = Instant::now();
                let appended = w.append(&image, at);
                encode += t.elapsed();
                if appended {
                    frames += 1;
                } else {
                    skipped += 1;
                }
            }
        });
        ticks += 1;
        busy += body.elapsed();
        tick += interval;
        match tick.checked_duration_since(Instant::now()) {
            Some(wait) => {
                let t = Instant::now();
                std::thread::sleep(wait);
                slept += t.elapsed();
            }
            // Behind: the next frame is due now, and the missed ticks are simply not recorded.
            None => {
                late += 1;
                tick = Instant::now();
            }
        }
    }
    let signalled = STOP.load(Ordering::SeqCst) && !QUITTING.load(Ordering::SeqCst);
    let seconds = started.elapsed().as_secs_f64();
    match writer.map(Writer::finish) {
        Some(Ok(())) => {
            remove_writer_temporaries(dir);
            let per_frame = |d: Duration| d.as_secs_f64() * 1000. / (frames + skipped).max(1) as f64;
            eprintln!(
                "FLEETD_RECORD done mp4={} frames={frames} skipped={skipped} ticks={ticks} late={late} pngs={pngs} seconds={seconds:.1} grab_ms={:.1} encode_ms={:.1} busy_ms={:.1} slept_ms={:.1}",
                mp4.display(),
                per_frame(grab),
                per_frame(encode),
                per_frame(busy),
                per_frame(slept)
            );
        }
        Some(Err(e)) => eprintln!("FLEETD_RECORD error={e}"),
        None if failed => {}
        None => eprintln!("FLEETD_RECORD error=no frame captured (window {window} never came back from CGWindowListCreateImage)"),
    }
    signalled
}

/// AVAssetWriter's faststart pass leaves its pre-pass copy (`fleetd.mp4.sb-*`) beside the finished file.
fn remove_writer_temporaries(dir: &Path) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with("fleetd.mp4.sb-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---- CoreGraphics / ImageIO ----

type CFTypeRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

const CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW: u32 = 1 << 3;
const CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
const CG_WINDOW_IMAGE_BEST_RESOLUTION: u32 = 1 << 3;
/// kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little: BGRA in memory, what the pixel buffer holds.
const BGRA_BITMAP_INFO: u32 = 2 | (2 << 12);

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCreateImage(bounds: CGRect, options: u32, window: u32, image_options: u32) -> CFTypeRef;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGImageGetWidth(image: CFTypeRef) -> usize;
    fn CGImageGetHeight(image: CFTypeRef) -> usize;
    fn CGColorSpaceCreateWithName(name: CFTypeRef) -> CFTypeRef;
    fn CGBitmapContextCreate(data: *mut c_void, width: usize, height: usize, bits: usize, row: usize, space: CFTypeRef, info: u32) -> CFTypeRef;
    fn CGContextSetRGBFillColor(cx: CFTypeRef, r: f64, g: f64, b: f64, a: f64);
    fn CGContextFillRect(cx: CFTypeRef, rect: CGRect);
    fn CGContextDrawImage(cx: CFTypeRef, rect: CGRect, image: CFTypeRef);
    static kCGColorSpaceSRGB: CFTypeRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFURLCreateFromFileSystemRepresentation(alloc: CFTypeRef, path: *const u8, len: isize, is_dir: bool) -> CFTypeRef;
    fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, encoding: u32) -> CFTypeRef;
}

#[link(name = "ImageIO", kind = "framework")]
unsafe extern "C" {
    fn CGImageDestinationCreateWithURL(url: CFTypeRef, kind: CFTypeRef, count: usize, options: CFTypeRef) -> CFTypeRef;
    fn CGImageDestinationAddImage(dest: CFTypeRef, image: CFTypeRef, props: CFTypeRef);
    fn CGImageDestinationFinalize(dest: CFTypeRef) -> bool;
}

/// An owned CF object, released on drop.
struct Cf(CFTypeRef);
impl Drop for Cf {
    fn drop(&mut self) {
        // SAFETY: created with a +1 retain count by a Create/Copy function.
        unsafe { CFRelease(self.0) }
    }
}

struct Image(Cf);
impl Image {
    fn width(&self) -> usize {
        // SAFETY: a live CGImage.
        unsafe { CGImageGetWidth(self.0.0) }
    }
    fn height(&self) -> usize {
        // SAFETY: a live CGImage.
        unsafe { CGImageGetHeight(self.0.0) }
    }
}

/// The window's own pixels at full (Retina) resolution, without the shadow.
fn capture(window: u32) -> Option<Image> {
    let null = CGRect { origin: CGPoint { x: f64::INFINITY, y: f64::INFINITY }, size: CGSize { width: 0., height: 0. } };
    // SAFETY: returns a +1 CGImage or NULL (window gone or not on screen yet).
    let image = unsafe {
        CGWindowListCreateImage(
            null,
            CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW,
            window,
            CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING | CG_WINDOW_IMAGE_BEST_RESOLUTION,
        )
    };
    if image.is_null() {
        return None;
    }
    let image = Image(Cf(image));
    (image.width() > 0 && image.height() > 0).then_some(image)
}

fn cf_string(s: &str) -> Cf {
    let c = CString::new(s).expect("no NUL");
    // SAFETY: a NUL-terminated UTF-8 string (kCFStringEncodingUTF8).
    Cf(unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), 0x0800_0100) })
}

fn write_png(image: &Image, path: &Path) {
    let bytes = path.as_os_str().as_encoded_bytes();
    // SAFETY: CF calls on live objects; each Create result is checked before use and released by Cf.
    unsafe {
        let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, false);
        if url.is_null() {
            return;
        }
        let url = Cf(url);
        let kind = cf_string("public.png");
        let dest = CGImageDestinationCreateWithURL(url.0, kind.0, 1, std::ptr::null());
        if dest.is_null() {
            return;
        }
        let dest = Cf(dest);
        CGImageDestinationAddImage(dest.0, image.0.0, std::ptr::null());
        if !CGImageDestinationFinalize(dest.0) {
            eprintln!("FLEETD_RECORD error=cannot write {}", path.display());
        }
    }
}

// ---- AVFoundation / CoreVideo ----

/// CMTime, passed by value to AVFoundation.
#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}
// SAFETY: matches CoreMedia's `{?=qiIq}`.
unsafe impl Encode for CMTime {
    const ENCODING: Encoding = Encoding::Struct("?", &[Encoding::LongLong, Encoding::Int, Encoding::UInt, Encoding::LongLong]);
}

/// A CVPixelBufferRef, typed so the selector's argument encoding (`^{__CVBuffer=}`) matches.
#[repr(transparent)]
#[derive(Clone, Copy)]
struct PixelBuffer(*mut c_void);
// SAFETY: a pointer to the opaque struct __CVBuffer.
unsafe impl Encode for PixelBuffer {
    const ENCODING: Encoding = Encoding::Pointer(&Encoding::Struct("__CVBuffer", &[]));
}
// SAFETY: as above.
unsafe impl RefEncode for PixelBuffer {
    const ENCODING_REF: Encoding = Encoding::Pointer(&<Self as Encode>::ENCODING);
}

/// A CVPixelBufferPoolRef (`^{__CVPixelBufferPool=}`), as `-pixelBufferPool` returns it.
#[repr(transparent)]
#[derive(Clone, Copy)]
struct Pool(*const c_void);
// SAFETY: a pointer to the opaque struct __CVPixelBufferPool.
unsafe impl Encode for Pool {
    const ENCODING: Encoding = Encoding::Pointer(&Encoding::Struct("__CVPixelBufferPool", &[]));
}
// SAFETY: as above.
unsafe impl RefEncode for Pool {
    const ENCODING_REF: Encoding = Encoding::Pointer(&<Self as Encode>::ENCODING);
}

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVFileTypeMPEG4: *const AnyObject;
    static AVMediaTypeVideo: *const AnyObject;
    static AVVideoCodecKey: *const AnyObject;
    static AVVideoCodecTypeH264: *const AnyObject;
    static AVVideoWidthKey: *const AnyObject;
    static AVVideoHeightKey: *const AnyObject;
    static AVVideoCompressionPropertiesKey: *const AnyObject;
    static AVVideoAverageBitRateKey: *const AnyObject;
    static AVVideoProfileLevelKey: *const AnyObject;
    static AVVideoProfileLevelH264HighAutoLevel: *const AnyObject;
    static AVVideoExpectedSourceFrameRateKey: *const AnyObject;
}

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    static kCVPixelBufferPixelFormatTypeKey: *const AnyObject;
    static kCVPixelBufferWidthKey: *const AnyObject;
    static kCVPixelBufferHeightKey: *const AnyObject;
    fn CVPixelBufferPoolCreatePixelBuffer(alloc: CFTypeRef, pool: CFTypeRef, out: *mut *mut c_void) -> i32;
    fn CVPixelBufferLockBaseAddress(pb: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(pb: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddress(pb: *mut c_void) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRow(pb: *mut c_void) -> usize;
    fn CVPixelBufferRelease(pb: *mut c_void);
}

const PIXEL_FORMAT_BGRA: i64 = 0x4247_5241;
const WRITER_COMPLETED: isize = 2;

struct Writer {
    writer: *mut AnyObject,
    input: *mut AnyObject,
    adaptor: *mut AnyObject,
    width: usize,
    height: usize,
    space: Cf,
}

fn number(n: i64) -> *mut AnyObject {
    // SAFETY: +[NSNumber numberWithLongLong:] returns an autoreleased NSNumber.
    unsafe { msg_send![class!(NSNumber), numberWithLongLong: n] }
}

fn dictionary(pairs: &[(*const AnyObject, *mut AnyObject)]) -> *mut AnyObject {
    let keys: Vec<*const AnyObject> = pairs.iter().map(|p| p.0).collect();
    let values: Vec<*mut AnyObject> = pairs.iter().map(|p| p.1).collect();
    // SAFETY: equal-length arrays of live objects.
    unsafe { msg_send![class!(NSDictionary), dictionaryWithObjects: values.as_ptr(), forKeys: keys.as_ptr(), count: pairs.len()] }
}

fn description(object: *mut AnyObject) -> String {
    if object.is_null() {
        return "unknown".into();
    }
    // SAFETY: -description and -UTF8String on a live object.
    unsafe {
        let text: *mut AnyObject = msg_send![object, description];
        let c: *const c_char = msg_send![text, UTF8String];
        if c.is_null() { "unknown".into() } else { std::ffi::CStr::from_ptr(c).to_string_lossy().into_owned() }
    }
}

impl Writer {
    fn new(path: &Path, width: usize, height: usize, fps: u32) -> Result<Self, String> {
        // H.264 wants even dimensions.
        let (width, height) = (width & !1, height & !1);
        let c_path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| "a NUL in the path")?;
        // SAFETY: AVFoundation calls with live arguments and the documented types; objects kept beyond this
        // pool come from alloc/init (+1) and live until the process ends.
        unsafe {
            let ns_path: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c_path.as_ptr()];
            let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: ns_path];
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let writer: *mut AnyObject = msg_send![class!(AVAssetWriter), alloc];
            let writer: *mut AnyObject = msg_send![writer, initWithURL: url, fileType: AVFileTypeMPEG4, error: &mut error];
            if writer.is_null() {
                return Err(format!("AVAssetWriter: {}", description(error)));
            }
            // Puts the moov atom first, like ffmpeg's +faststart.
            let _: () = msg_send![writer, setShouldOptimizeForNetworkUse: true];
            // About 0.08 bits per pixel per frame: text stays crisp (a Retina window at 30 fps gets ~12 Mbit/s), and a
            // 15-minute master stays near 1.5 GB.
            let bitrate = ((width * height) as i64 * i64::from(fps) / 12).clamp(4_000_000, 24_000_000);
            let compression = dictionary(&[
                (AVVideoAverageBitRateKey, number(bitrate)),
                (AVVideoProfileLevelKey, AVVideoProfileLevelH264HighAutoLevel.cast_mut()),
                (AVVideoExpectedSourceFrameRateKey, number(i64::from(fps))),
            ]);
            let settings = dictionary(&[
                (AVVideoCodecKey, AVVideoCodecTypeH264.cast_mut()),
                (AVVideoWidthKey, number(width as i64)),
                (AVVideoHeightKey, number(height as i64)),
                (AVVideoCompressionPropertiesKey, compression),
            ]);
            let input: *mut AnyObject = msg_send![class!(AVAssetWriterInput), alloc];
            let input: *mut AnyObject = msg_send![input, initWithMediaType: AVMediaTypeVideo, outputSettings: settings];
            let _: () = msg_send![input, setExpectsMediaDataInRealTime: true];
            let attributes = dictionary(&[
                (kCVPixelBufferPixelFormatTypeKey, number(PIXEL_FORMAT_BGRA)),
                (kCVPixelBufferWidthKey, number(width as i64)),
                (kCVPixelBufferHeightKey, number(height as i64)),
            ]);
            let adaptor: *mut AnyObject = msg_send![class!(AVAssetWriterInputPixelBufferAdaptor), alloc];
            let adaptor: *mut AnyObject = msg_send![adaptor, initWithAssetWriterInput: input, sourcePixelBufferAttributes: attributes];
            let can_add: bool = msg_send![writer, canAddInput: input];
            if !can_add {
                return Err("AVAssetWriter refused the H.264 input".into());
            }
            let _: () = msg_send![writer, addInput: input];
            let started: bool = msg_send![writer, startWriting];
            if !started {
                let error: *mut AnyObject = msg_send![writer, error];
                return Err(format!("startWriting: {}", description(error)));
            }
            let _: () = msg_send![writer, startSessionAtSourceTime: CMTime { value: 0, timescale: 1_000_000, flags: 1, epoch: 0 }];
            let space = Cf(CGColorSpaceCreateWithName(kCGColorSpaceSRGB));
            Ok(Self { writer, input, adaptor, width, height, space })
        }
    }

    /// Draws the frame into a pooled pixel buffer and appends it at `at`; false when the encoder is busy.
    fn append(&self, image: &Image, at: Duration) -> bool {
        // SAFETY: the pool and buffers belong to the adaptor; the buffer is locked while drawn into.
        unsafe {
            let ready: bool = msg_send![self.input, isReadyForMoreMediaData];
            if !ready {
                return false;
            }
            let pool: Pool = msg_send![self.adaptor, pixelBufferPool];
            if pool.0.is_null() {
                return false;
            }
            let mut pb: *mut c_void = std::ptr::null_mut();
            if CVPixelBufferPoolCreatePixelBuffer(std::ptr::null(), pool.0, &mut pb) != 0 || pb.is_null() {
                return false;
            }
            CVPixelBufferLockBaseAddress(pb, 0);
            let cx = CGBitmapContextCreate(
                CVPixelBufferGetBaseAddress(pb),
                self.width,
                self.height,
                8,
                CVPixelBufferGetBytesPerRow(pb),
                self.space.0,
                BGRA_BITMAP_INFO,
            );
            if !cx.is_null() {
                let cx = Cf(cx);
                let full = CGRect { origin: CGPoint { x: 0., y: 0. }, size: CGSize { width: self.width as f64, height: self.height as f64 } };
                // The window's rounded corners are transparent; black behind them, as on a dark desk.
                CGContextSetRGBFillColor(cx.0, 0., 0., 0., 1.);
                CGContextFillRect(cx.0, full);
                // Top-left anchored at 1:1, so a resized window crops or pads instead of stretching.
                let (w, h) = (image.width() as f64, image.height() as f64);
                let rect = CGRect { origin: CGPoint { x: 0., y: self.height as f64 - h }, size: CGSize { width: w, height: h } };
                CGContextDrawImage(cx.0, rect, image.0.0);
            }
            CVPixelBufferUnlockBaseAddress(pb, 0);
            let time = CMTime { value: at.as_micros() as i64, timescale: 1_000_000, flags: 1, epoch: 0 };
            let ok: bool = msg_send![self.adaptor, appendPixelBuffer: PixelBuffer(pb), withPresentationTime: time];
            CVPixelBufferRelease(pb);
            ok
        }
    }

    fn finish(self) -> Result<(), String> {
        // The file is whole once the completion handler has run, not when the status first reads Completed.
        let finished = std::sync::Arc::new(AtomicBool::new(false));
        let flag = finished.clone();
        let block = block2::RcBlock::new(move || flag.store(true, Ordering::SeqCst));
        // SAFETY: AVAssetWriter calls on the live writer; it copies the block.
        unsafe {
            let _: () = msg_send![self.input, markAsFinished];
            let _: () = msg_send![self.writer, finishWritingWithCompletionHandler: &*block];
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !finished.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: as above.
        let status: isize = unsafe { msg_send![self.writer, status] };
        if finished.load(Ordering::SeqCst) && status == WRITER_COMPLETED {
            return Ok(());
        }
        // SAFETY: as above.
        let error: *mut AnyObject = unsafe { msg_send![self.writer, error] };
        Err(format!("finishWriting (status {status}): {}", description(error)))
    }
}
