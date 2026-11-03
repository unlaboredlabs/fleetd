//! The macOS calls a Mac screen makes, opened with dlopen: the darwin binary is cross-built without a macOS SDK and
//! must link no framework (.github/release/check-darwin-deps.sh), as node/power does for IOKit. CoreGraphics gives
//! CGEvent input, the CGImage a capture returns and the Screen Recording preflight; ScreenCaptureKit, reached through
//! the Objective-C runtime, gives the frames; ApplicationServices says whether Accessibility is granted.
//!
//! ScreenCaptureKit answers through completion blocks. A block here is a stack block with no copy helpers: its one
//! captured word is a pointer the node made with `Arc::into_raw`, which the runtime's Block_copy copies as plain
//! bytes and the block's function takes back exactly once.
// The fields keep macOS's own names; each `transmute` takes its type from the field it fills.
#![allow(
    non_snake_case,
    clippy::upper_case_acronyms,
    clippy::missing_transmute_annotations
)]

use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::OnceLock;

pub type Id = *mut c_void;
pub type Sel = *const c_void;
pub type CFTypeRef = *const c_void;
pub type CGEventRef = *mut c_void;
pub type CGImageRef = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGRect {
    pub origin: CGPoint,
    pub size: CGSize,
}

/// The block literal's layout (clang's Block ABI), with one captured word.
#[repr(C)]
pub struct Block {
    pub isa: *const c_void,
    pub flags: i32,
    pub reserved: i32,
    pub invoke: *const c_void,
    pub descriptor: *const BlockDescriptor,
    pub context: *const c_void,
}

#[repr(C)]
pub struct BlockDescriptor {
    pub reserved: usize,
    pub size: usize,
}

pub static DESCRIPTOR: BlockDescriptor = BlockDescriptor {
    reserved: 0,
    size: std::mem::size_of::<Block>(),
};

pub struct Api {
    // Objective-C
    pub objc_getClass: unsafe extern "C" fn(*const c_char) -> Id,
    pub sel_registerName: unsafe extern "C" fn(*const c_char) -> Sel,
    /// Cast to each call's own signature before use.
    pub objc_msgSend: *const c_void,
    pub objc_retain: unsafe extern "C" fn(Id) -> Id,
    pub objc_release: unsafe extern "C" fn(Id),
    pub objc_autoreleasePoolPush: unsafe extern "C" fn() -> *mut c_void,
    pub objc_autoreleasePoolPop: unsafe extern "C" fn(*mut c_void),
    pub stack_block: *const c_void,
    // CoreFoundation
    pub CFRelease: unsafe extern "C" fn(CFTypeRef),
    pub CFRetain: unsafe extern "C" fn(CFTypeRef) -> CFTypeRef,
    pub CFDataGetLength: unsafe extern "C" fn(CFTypeRef) -> isize,
    pub CFDataGetBytePtr: unsafe extern "C" fn(CFTypeRef) -> *const u8,
    // CoreGraphics
    pub CGMainDisplayID: unsafe extern "C" fn() -> u32,
    pub CGDisplayBounds: unsafe extern "C" fn(u32) -> CGRect,
    pub CGPreflightScreenCaptureAccess: unsafe extern "C" fn() -> bool,
    pub CGImageGetWidth: unsafe extern "C" fn(CGImageRef) -> usize,
    pub CGImageGetHeight: unsafe extern "C" fn(CGImageRef) -> usize,
    pub CGImageGetBytesPerRow: unsafe extern "C" fn(CGImageRef) -> usize,
    pub CGImageGetBitsPerPixel: unsafe extern "C" fn(CGImageRef) -> usize,
    pub CGImageGetBitmapInfo: unsafe extern "C" fn(CGImageRef) -> u32,
    pub CGImageGetDataProvider: unsafe extern "C" fn(CGImageRef) -> CFTypeRef,
    pub CGDataProviderCopyData: unsafe extern "C" fn(CFTypeRef) -> CFTypeRef,
    pub CGEventCreate: unsafe extern "C" fn(*const c_void) -> CGEventRef,
    pub CGEventGetLocation: unsafe extern "C" fn(CGEventRef) -> CGPoint,
    pub CGEventCreateMouseEvent:
        unsafe extern "C" fn(*const c_void, u32, CGPoint, u32) -> CGEventRef,
    pub CGEventCreateKeyboardEvent: unsafe extern "C" fn(*const c_void, u16, bool) -> CGEventRef,
    pub CGEventCreateScrollWheelEvent2:
        unsafe extern "C" fn(*const c_void, u32, u32, i32, i32, i32) -> CGEventRef,
    pub CGEventKeyboardSetUnicodeString: unsafe extern "C" fn(CGEventRef, usize, *const u16),
    pub CGEventSetFlags: unsafe extern "C" fn(CGEventRef, u64),
    pub CGEventSetIntegerValueField: unsafe extern "C" fn(CGEventRef, u32, i64),
    pub CGEventPost: unsafe extern "C" fn(u32, CGEventRef),
    // ApplicationServices
    pub AXIsProcessTrusted: unsafe extern "C" fn() -> bool,
}

// SAFETY: the pointers are functions and a constant class, never written after loading.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn open(path: &str) -> Result<*mut c_void, String> {
    let c = CString::new(path).map_err(|e| e.to_string())?;
    // SAFETY: a NUL-terminated path; the library is never closed.
    let lib = unsafe { libc::dlopen(c.as_ptr(), libc::RTLD_LAZY | libc::RTLD_GLOBAL) };
    if lib.is_null() {
        return Err(format!("cannot open {path}"));
    }
    Ok(lib)
}

fn symbol(lib: *mut c_void, name: &str) -> Result<*mut c_void, String> {
    let c = CString::new(name).map_err(|e| e.to_string())?;
    // SAFETY: `lib` came from dlopen and is never closed.
    let f = unsafe { libc::dlsym(lib, c.as_ptr()) };
    if f.is_null() {
        return Err(format!("macOS has no {name}"));
    }
    Ok(f)
}

fn load() -> Result<Api, String> {
    let objc = open("/usr/lib/libobjc.A.dylib")?;
    let system = open("/usr/lib/libSystem.B.dylib")?;
    let cf = open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")?;
    let cg = open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")?;
    let ax = open("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")?;
    // Loaded for its classes, which the runtime finds by name from then on.
    open("/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit")?;
    macro_rules! f {
        ($lib:expr, $name:literal) => {
            // SAFETY: the symbol is the macOS function of that name, whose signature the field spells.
            unsafe { std::mem::transmute::<*mut c_void, _>(symbol($lib, $name)?) }
        };
    }
    Ok(Api {
        objc_getClass: f!(objc, "objc_getClass"),
        sel_registerName: f!(objc, "sel_registerName"),
        objc_msgSend: symbol(objc, "objc_msgSend")?,
        objc_retain: f!(objc, "objc_retain"),
        objc_release: f!(objc, "objc_release"),
        objc_autoreleasePoolPush: f!(objc, "objc_autoreleasePoolPush"),
        objc_autoreleasePoolPop: f!(objc, "objc_autoreleasePoolPop"),
        stack_block: symbol(system, "_NSConcreteStackBlock")?,
        CFRelease: f!(cf, "CFRelease"),
        CFRetain: f!(cf, "CFRetain"),
        CFDataGetLength: f!(cf, "CFDataGetLength"),
        CFDataGetBytePtr: f!(cf, "CFDataGetBytePtr"),
        CGMainDisplayID: f!(cg, "CGMainDisplayID"),
        CGDisplayBounds: f!(cg, "CGDisplayBounds"),
        CGPreflightScreenCaptureAccess: f!(cg, "CGPreflightScreenCaptureAccess"),
        CGImageGetWidth: f!(cg, "CGImageGetWidth"),
        CGImageGetHeight: f!(cg, "CGImageGetHeight"),
        CGImageGetBytesPerRow: f!(cg, "CGImageGetBytesPerRow"),
        CGImageGetBitsPerPixel: f!(cg, "CGImageGetBitsPerPixel"),
        CGImageGetBitmapInfo: f!(cg, "CGImageGetBitmapInfo"),
        CGImageGetDataProvider: f!(cg, "CGImageGetDataProvider"),
        CGDataProviderCopyData: f!(cg, "CGDataProviderCopyData"),
        CGEventCreate: f!(cg, "CGEventCreate"),
        CGEventGetLocation: f!(cg, "CGEventGetLocation"),
        CGEventCreateMouseEvent: f!(cg, "CGEventCreateMouseEvent"),
        CGEventCreateKeyboardEvent: f!(cg, "CGEventCreateKeyboardEvent"),
        CGEventCreateScrollWheelEvent2: f!(cg, "CGEventCreateScrollWheelEvent2"),
        CGEventKeyboardSetUnicodeString: f!(cg, "CGEventKeyboardSetUnicodeString"),
        CGEventSetFlags: f!(cg, "CGEventSetFlags"),
        CGEventSetIntegerValueField: f!(cg, "CGEventSetIntegerValueField"),
        CGEventPost: f!(cg, "CGEventPost"),
        AXIsProcessTrusted: f!(ax, "AXIsProcessTrusted"),
    })
}

/// The calls, loaded once; why not, on a Mac that lacks one (ScreenCaptureKit's screenshots need macOS 14).
pub fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(load).as_ref().map_err(Clone::clone)
}

impl Api {
    pub fn class(&self, name: &CStr) -> Result<Id, String> {
        // SAFETY: a NUL-terminated class name.
        let class = unsafe { (self.objc_getClass)(name.as_ptr()) };
        if class.is_null() {
            return Err(format!(
                "macOS has no {} (ScreenCaptureKit's screenshots need macOS 14 or later)",
                name.to_string_lossy()
            ));
        }
        Ok(class)
    }

    pub fn sel(&self, name: &CStr) -> Sel {
        // SAFETY: a NUL-terminated selector name; the runtime interns it.
        unsafe { (self.sel_registerName)(name.as_ptr()) }
    }

    /// `[receiver sel]` returning an object (or nil).
    ///
    /// # Safety
    /// `receiver` answers `sel` with no arguments and an object (or a pointer-sized integer, read as one).
    pub unsafe fn send(&self, receiver: Id, sel: &CStr) -> Id {
        let f: unsafe extern "C" fn(Id, Sel) -> Id =
            unsafe { std::mem::transmute(self.objc_msgSend) };
        unsafe { f(receiver, self.sel(sel)) }
    }

    /// `[receiver sel:arg]` with one pointer-sized argument, returning a pointer-sized value.
    ///
    /// # Safety
    /// `receiver` answers `sel` with that one argument.
    pub unsafe fn send1(&self, receiver: Id, sel: &CStr, arg: usize) -> Id {
        let f: unsafe extern "C" fn(Id, Sel, usize) -> Id =
            unsafe { std::mem::transmute(self.objc_msgSend) };
        unsafe { f(receiver, self.sel(sel), arg) }
    }

    /// `[receiver sel:a b:b]` with two pointer-sized arguments.
    ///
    /// # Safety
    /// `receiver` answers `sel` with those arguments.
    pub unsafe fn send2(&self, receiver: Id, sel: &CStr, a: usize, b: usize) -> Id {
        let f: unsafe extern "C" fn(Id, Sel, usize, usize) -> Id =
            unsafe { std::mem::transmute(self.objc_msgSend) };
        unsafe { f(receiver, self.sel(sel), a, b) }
    }

    /// `[receiver sel:a b:b c:c]` with three pointer-sized arguments.
    ///
    /// # Safety
    /// `receiver` answers `sel` with those arguments.
    pub unsafe fn send3(&self, receiver: Id, sel: &CStr, a: usize, b: usize, c: usize) -> Id {
        let f: unsafe extern "C" fn(Id, Sel, usize, usize, usize) -> Id =
            unsafe { std::mem::transmute(self.objc_msgSend) };
        unsafe { f(receiver, self.sel(sel), a, b, c) }
    }

    /// A stack block calling `invoke` with `context` as its captured word.
    pub fn block(&self, invoke: *const c_void, context: *const c_void) -> Block {
        Block {
            isa: self.stack_block,
            flags: 0,
            reserved: 0,
            invoke,
            descriptor: &DESCRIPTOR,
            context,
        }
    }

    /// An NSError's localizedDescription.
    ///
    /// # Safety
    /// `error` is nil or an NSError.
    pub unsafe fn error_text(&self, error: Id) -> String {
        if error.is_null() {
            return "no error given".to_owned();
        }
        unsafe {
            let text = self.send(error, c"localizedDescription");
            let code = self.send(error, c"code") as isize;
            let utf8 = self.send(text, c"UTF8String") as *const c_char;
            let said = if utf8.is_null() {
                String::new()
            } else {
                CStr::from_ptr(utf8).to_string_lossy().into_owned()
            };
            format!("{said} (code {code})")
        }
    }
}

/// Runs `f` inside an autorelease pool, so what the calls autorelease on this thread goes when it ends.
pub fn pooled<T>(api: &Api, f: impl FnOnce() -> T) -> T {
    // SAFETY: push and pop pair on this thread.
    let pool = unsafe { (api.objc_autoreleasePoolPush)() };
    let out = f();
    unsafe { (api.objc_autoreleasePoolPop)(pool) };
    out
}
