//! The two privacy grants the agents' Mac needs, read exactly and never prompting: Accessibility
//! (`AXIsProcessTrusted`) and Screen Recording (`CGPreflightScreenCaptureAccess`). macOS grants them to the node, the
//! process launchd started, and its children share them. [`ask_once`] puts fleetd in both lists of System Settings,
//! where the person turns it on.
//!
//! The frameworks are opened with dlopen: the darwin binary is cross-built without a macOS SDK and must link no
//! framework (.github/release/check-darwin-deps.sh).
use std::ffi::{CStr, c_void};
use std::sync::OnceLock;

type Ask = unsafe extern "C" fn() -> u8;
type AskWith = unsafe extern "C" fn(*const c_void) -> u8;
type DictCreate = unsafe extern "C" fn(
    *const c_void,
    *const *const c_void,
    *const *const c_void,
    isize,
    *const c_void,
    *const c_void,
) -> *const c_void;
type CfRelease = unsafe extern "C" fn(*const c_void);

struct Api {
    ax_trusted: Ask,
    ax_trusted_with: AskWith,
    ax_prompt_key: *const *const c_void,
    preflight: Ask,
    request: Ask,
    dict_create: DictCreate,
    cf_release: CfRelease,
    cf_true: *const *const c_void,
    key_callbacks: *const c_void,
    value_callbacks: *const c_void,
}

// SAFETY: the pointers are to framework globals, which live as long as the process and are only read.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn open(path: &CStr) -> Option<*mut c_void> {
    // SAFETY: a constant, NUL-terminated framework path.
    let lib = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY) };
    (!lib.is_null()).then_some(lib)
}

fn symbol(lib: *mut c_void, name: &CStr) -> Option<*mut c_void> {
    // SAFETY: `lib` came from dlopen and is never closed.
    let f = unsafe { libc::dlsym(lib, name.as_ptr()) };
    (!f.is_null()).then_some(f)
}

fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| {
        let ax =
            open(c"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")?;
        let cg = open(c"/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")?;
        let cf = open(c"/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")?;
        // SAFETY: each symbol has this C signature (or is this global) in the macOS SDK headers.
        unsafe {
            Some(Api {
                ax_trusted: std::mem::transmute::<*mut c_void, Ask>(symbol(
                    ax,
                    c"AXIsProcessTrusted",
                )?),
                ax_trusted_with: std::mem::transmute::<*mut c_void, AskWith>(symbol(
                    ax,
                    c"AXIsProcessTrustedWithOptions",
                )?),
                ax_prompt_key: symbol(ax, c"kAXTrustedCheckOptionPrompt")? as *const *const c_void,
                preflight: std::mem::transmute::<*mut c_void, Ask>(symbol(
                    cg,
                    c"CGPreflightScreenCaptureAccess",
                )?),
                request: std::mem::transmute::<*mut c_void, Ask>(symbol(
                    cg,
                    c"CGRequestScreenCaptureAccess",
                )?),
                dict_create: std::mem::transmute::<*mut c_void, DictCreate>(symbol(
                    cf,
                    c"CFDictionaryCreate",
                )?),
                cf_release: std::mem::transmute::<*mut c_void, CfRelease>(symbol(
                    cf,
                    c"CFRelease",
                )?),
                cf_true: symbol(cf, c"kCFBooleanTrue")? as *const *const c_void,
                key_callbacks: symbol(cf, c"kCFTypeDictionaryKeyCallBacks")?,
                value_callbacks: symbol(cf, c"kCFTypeDictionaryValueCallBacks")?,
            })
        }
    })
    .as_ref()
}

pub fn accessibility() -> Option<bool> {
    let api = api()?;
    // SAFETY: no arguments; it only reads the process's grant.
    Some(unsafe { (api.ax_trusted)() } != 0)
}

pub fn screen_recording() -> Option<bool> {
    let api = api()?;
    // SAFETY: no arguments; it only reads the process's grant, without a prompt.
    Some(unsafe { (api.preflight)() } != 0)
}

/// Asks macOS for each grant the node lacks, once: that adds fleetd to its System Settings list (switched off) and
/// shows macOS's own prompt at the Mac.
pub fn ask_once() {
    let Some(api) = api() else { return };
    if accessibility() == Some(false) {
        // SAFETY: a one-entry CFDictionary of CF globals, released after the call.
        unsafe {
            let keys = [*api.ax_prompt_key];
            let values = [*api.cf_true];
            let options = (api.dict_create)(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                api.key_callbacks,
                api.value_callbacks,
            );
            if !options.is_null() {
                (api.ax_trusted_with)(options);
                (api.cf_release)(options);
            }
        }
    }
    if screen_recording() == Some(false) {
        // SAFETY: no arguments.
        unsafe { (api.request)() };
    }
}

#[cfg(test)]
mod tests {
    /// On the CI Mac only: both grants can be read, whatever they are, and reading never prompts.
    #[test]
    fn reads_both_grants() {
        if std::env::var_os("CI").is_none() {
            return;
        }
        assert!(super::accessibility().is_some());
        assert!(super::screen_recording().is_some());
    }
}
