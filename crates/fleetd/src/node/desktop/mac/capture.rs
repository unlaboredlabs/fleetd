//! The Mac's screen through ScreenCaptureKit: one SCScreenshotManager capture of the main display per frame, at the
//! display's size in points, so a frame's pixels are the coordinates CGEvent takes. The content filter and the
//! configuration are kept between frames and made again when the display's size changes or a capture fails.
use std::ffi::c_void;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::ffi::{self, Api, CGImageRef, Id};
use crate::node::desktop::screen::Raw;

/// How long one capture may take before the node gives up on it.
const CAPTURE_WAIT: Duration = Duration::from_secs(5);
/// kCVPixelFormatType_32BGRA.
const BGRA: usize = 0x4247_5241;
/// CGBitmapInfo's byte order mask, and its 32-bit little-endian order (BGRA in memory with alpha first).
const BYTE_ORDER_MASK: u32 = 0x7000;
const BYTE_ORDER_32_LITTLE: u32 = 2 << 12;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Where a completion block leaves its answer.
struct Slot<T> {
    answer: Mutex<Option<T>>,
    done: Condvar,
}

impl<T> Slot<T> {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            answer: Mutex::new(None),
            done: Condvar::new(),
        })
    }

    fn put(&self, answer: T) {
        *lock(&self.answer) = Some(answer);
        self.done.notify_all();
    }

    fn wait(&self) -> Option<T> {
        let held = lock(&self.answer);
        let (mut held, _) = self
            .done
            .wait_timeout_while(held, CAPTURE_WAIT, |a| a.is_none())
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        held.take()
    }
}

/// An object, or the error text a completion gave instead. Objects are retained here and released by their owner.
type Answer = Result<usize, String>;

/// `^(id object, NSError *error)`: the object retained, or the error's text.
unsafe extern "C" fn object_done(block: *const ffi::Block, object: Id, error: Id) {
    // SAFETY: the block's context is the Arc<Slot> made for this one call; the completion runs once.
    unsafe {
        let slot = Arc::from_raw((*block).context as *const Slot<Answer>);
        let Ok(api) = ffi::api() else {
            return;
        };
        if object.is_null() {
            slot.put(Err(api.error_text(error)));
        } else {
            slot.put(Ok((api.objc_retain)(object) as usize));
        }
    }
}

/// `^(CGImageRef image, NSError *error)`: the image retained, or the error's text.
unsafe extern "C" fn image_done(block: *const ffi::Block, image: CGImageRef, error: Id) {
    // SAFETY: as object_done's.
    unsafe {
        let slot = Arc::from_raw((*block).context as *const Slot<Answer>);
        let Ok(api) = ffi::api() else {
            return;
        };
        if image.is_null() {
            slot.put(Err(api.error_text(error)));
        } else {
            slot.put(Ok((api.CFRetain)(image) as usize));
        }
    }
}

/// Calls `start` with a completion block, and waits for what the block is given.
fn completion(
    api: &Api,
    invoke: *const c_void,
    start: impl FnOnce(&ffi::Block),
) -> Result<usize, String> {
    let slot = Slot::<Answer>::new();
    let context = Arc::into_raw(slot.clone()) as *const c_void;
    let block = api.block(invoke, context);
    start(&block);
    // A completion that never comes keeps its one reference: a few bytes, against a crash if it came late.
    slot.wait()
        .unwrap_or_else(|| Err("ScreenCaptureKit did not answer in 5 s".into()))
}

/// What a capture is made with, kept between frames.
struct Made {
    filter: Id,
    config: Id,
    width: usize,
    height: usize,
}

pub struct Capture {
    made: Mutex<Option<Made>>,
}

// SAFETY: the filter and configuration are only used under the mutex, and ScreenCaptureKit's objects may be used from
// any thread.
unsafe impl Send for Capture {}
unsafe impl Sync for Capture {}

impl Drop for Capture {
    fn drop(&mut self) {
        if let (Some(made), Ok(api)) = (lock(&self.made).take(), ffi::api()) {
            // SAFETY: both were made here, +1.
            unsafe {
                (api.objc_release)(made.filter);
                (api.objc_release)(made.config);
            }
        }
    }
}

impl Capture {
    pub fn new() -> Self {
        Self {
            made: Mutex::new(None),
        }
    }

    /// The main display's size in points.
    pub fn size() -> Result<(u32, u32), String> {
        let api = ffi::api()?;
        // SAFETY: plain CoreGraphics calls.
        let bounds = unsafe { (api.CGDisplayBounds)((api.CGMainDisplayID)()) };
        Ok((
            bounds.size.width.max(1.0) as u32,
            bounds.size.height.max(1.0) as u32,
        ))
    }

    /// The filter on the main display, and a configuration of its size in BGRA with the pointer drawn.
    fn make(api: &Api, width: usize, height: usize) -> Result<Made, String> {
        let shareable = api.class(c"SCShareableContent")?;
        // SAFETY: getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler: takes two BOOLs
        // and a block of (SCShareableContent *, NSError *).
        let content = completion(api, object_done as *const c_void, |block| unsafe {
            api.send3(
                shareable,
                c"getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:",
                0,
                1,
                block as *const ffi::Block as usize,
            );
        })
        .map_err(|why| format!("macOS refused to list the screen's content: {why}"))? as Id;
        // SAFETY: `content` is an SCShareableContent, retained by object_done; displays is an NSArray of SCDisplay.
        let display = unsafe {
            let main = (api.CGMainDisplayID)();
            let displays = api.send(content, c"displays");
            let count = api.send(displays, c"count") as usize;
            let found = (0..count)
                .map(|i| api.send1(displays, c"objectAtIndex:", i))
                .find(|d| api.send(*d, c"displayID") as usize as u32 == main)
                .or_else(|| (count > 0).then(|| api.send1(displays, c"objectAtIndex:", 0)));
            let found = found.map(|d| (api.objc_retain)(d));
            (api.objc_release)(content);
            found.ok_or("macOS lists no display to capture")?
        };
        // SAFETY: SCContentFilter's initWithDisplay:excludingWindows: takes an SCDisplay and an NSArray; the
        // configuration's setters take integers and a BOOL.
        unsafe {
            let empty = api.send(api.class(c"NSArray")?, c"array");
            let filter = api.send(api.class(c"SCContentFilter")?, c"alloc");
            let filter = api.send2(
                filter,
                c"initWithDisplay:excludingWindows:",
                display as usize,
                empty as usize,
            );
            (api.objc_release)(display);
            if filter.is_null() {
                return Err("ScreenCaptureKit made no content filter for the display".into());
            }
            let config = api.send(api.class(c"SCStreamConfiguration")?, c"alloc");
            let config = api.send(config, c"init");
            api.send1(config, c"setWidth:", width);
            api.send1(config, c"setHeight:", height);
            api.send1(config, c"setPixelFormat:", BGRA);
            api.send1(config, c"setShowsCursor:", 1);
            Ok(Made {
                filter,
                config,
                width,
                height,
            })
        }
    }

    /// One frame of the main display.
    pub fn grab(&self) -> Result<Raw, String> {
        let api = ffi::api()?;
        let (width, height) = Self::size()?;
        let (width, height) = (width as usize, height as usize);
        ffi::pooled(api, || {
            let mut made = lock(&self.made);
            if made
                .as_ref()
                .is_some_and(|m| (m.width, m.height) != (width, height))
                && let Some(old) = made.take()
            {
                // SAFETY: made here, +1.
                unsafe {
                    (api.objc_release)(old.filter);
                    (api.objc_release)(old.config);
                }
            }
            if made.is_none() {
                *made = Some(Self::make(api, width, height)?);
            }
            let m = made.as_ref().expect("made above");
            let manager = api.class(c"SCScreenshotManager")?;
            // SAFETY: captureImageWithFilter:configuration:completionHandler: takes the filter, the configuration and
            // a block of (CGImageRef, NSError *).
            let captured = completion(api, image_done as *const c_void, |block| unsafe {
                api.send3(
                    manager,
                    c"captureImageWithFilter:configuration:completionHandler:",
                    m.filter as usize,
                    m.config as usize,
                    block as *const ffi::Block as usize,
                );
            });
            let image = match captured {
                Ok(image) => image as CGImageRef,
                Err(why) => {
                    // Made again for the next frame: the display may have gone or changed.
                    if let Some(old) = made.take() {
                        // SAFETY: made here, +1.
                        unsafe {
                            (api.objc_release)(old.filter);
                            (api.objc_release)(old.config);
                        }
                    }
                    return Err(format!("the screen was not captured: {why}"));
                }
            };
            drop(made);
            // SAFETY: `image` is a CGImage retained by image_done, released here once read.
            let raw = unsafe { pixels(api, image) };
            unsafe { (api.CFRelease)(image) };
            raw
        })
    }
}

/// A CGImage's pixels as packed BGRA rows.
///
/// # Safety
/// `image` is a live CGImage.
unsafe fn pixels(api: &Api, image: CGImageRef) -> Result<Raw, String> {
    unsafe {
        let width = (api.CGImageGetWidth)(image);
        let height = (api.CGImageGetHeight)(image);
        let stride = (api.CGImageGetBytesPerRow)(image);
        if (api.CGImageGetBitsPerPixel)(image) != 32 || stride < width * 4 {
            return Err("the captured screen isn't 32-bit color".into());
        }
        let little = (api.CGImageGetBitmapInfo)(image) & BYTE_ORDER_MASK == BYTE_ORDER_32_LITTLE;
        let data = (api.CGDataProviderCopyData)((api.CGImageGetDataProvider)(image));
        if data.is_null() {
            return Err("the captured screen has no pixels".into());
        }
        let len = (api.CFDataGetLength)(data) as usize;
        let bytes = std::slice::from_raw_parts((api.CFDataGetBytePtr)(data), len);
        let mut out = Vec::with_capacity(width * height * 4);
        for row in bytes.chunks(stride).take(height) {
            let row = &row[..(width * 4).min(row.len())];
            if little {
                out.extend_from_slice(row);
            } else {
                // ARGB in memory: the same bytes reversed in each pixel.
                out.extend(
                    row.as_chunks::<4>()
                        .0
                        .iter()
                        .flat_map(|[a, r, g, b]| [*b, *g, *r, *a]),
                );
            }
        }
        (api.CFRelease)(data);
        if out.len() < width * height * 4 {
            return Err("the captured screen came short".into());
        }
        Ok(Raw {
            data: out,
            width: width as u32,
            height: height as u32,
        })
    }
}
