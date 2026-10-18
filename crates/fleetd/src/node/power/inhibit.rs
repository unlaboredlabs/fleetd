//! The sleep inhibitor the node holds while agents run. Dropping a [`Hold`] releases it, and so does the node dying:
//! on Linux it is a file descriptor logind hands out, on macOS an IOPMAssertion the kernel drops with the process.

/// Shown by `systemd-inhibit --list` and `pmset -g assertions`.
pub fn why(running: usize) -> String {
    match running {
        1 => "fleetd: 1 agent running".to_owned(),
        n => format!("fleetd: {n} agents running"),
    }
}

#[cfg(target_os = "linux")]
pub use linux::{Hold, take};
#[cfg(target_os = "macos")]
pub use macos::{Hold, take};

#[cfg(target_os = "linux")]
mod linux {
    /// logind's inhibitor: it lasts while this descriptor is open.
    pub struct Hold(#[allow(dead_code)] zbus::zvariant::OwnedFd);

    /// logind `Inhibit("idle:sleep", "fleetd", why, "block")` on the system bus.
    pub async fn take(why: &str) -> Result<Hold, String> {
        let bus = zbus::Connection::system()
            .await
            .map_err(|e| format!("no system bus: {e}"))?;
        let reply = bus
            .call_method(
                Some("org.freedesktop.login1"),
                "/org/freedesktop/login1",
                Some("org.freedesktop.login1.Manager"),
                "Inhibit",
                &("idle:sleep", "fleetd", why, "block"),
            )
            .await
            .map_err(|e| format!("logind refused the inhibitor: {e}"))?;
        reply
            .body()
            .deserialize::<zbus::zvariant::OwnedFd>()
            .map(Hold)
            .map_err(|e| format!("logind answered without a descriptor: {e}"))
    }
}

#[cfg(target_os = "macos")]
mod macos {
    //! IOKit and CoreFoundation are opened with dlopen: the darwin binary is cross-built without a macOS SDK and
    //! must link no framework (.github/release/check-darwin-deps.sh).
    use std::ffi::{CStr, CString, c_char, c_void};
    use std::sync::OnceLock;

    type CfString = *const c_void;
    const UTF8: u32 = 0x0800_0100;
    const LEVEL_ON: u32 = 255;

    struct Api {
        create: unsafe extern "C" fn(CfString, u32, CfString, *mut u32) -> i32,
        release: unsafe extern "C" fn(u32) -> i32,
        cf_string: unsafe extern "C" fn(*const c_void, *const c_char, u32) -> CfString,
        cf_release: unsafe extern "C" fn(*const c_void),
    }

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
            let iokit = open(c"/System/Library/Frameworks/IOKit.framework/IOKit")?;
            let cf = open(c"/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")?;
            // SAFETY: each symbol has this C signature in the macOS SDK headers.
            unsafe {
                Some(Api {
                    create: std::mem::transmute::<*mut c_void, _>(symbol(
                        iokit,
                        c"IOPMAssertionCreateWithName",
                    )?),
                    release: std::mem::transmute::<*mut c_void, _>(symbol(
                        iokit,
                        c"IOPMAssertionRelease",
                    )?),
                    cf_string: std::mem::transmute::<*mut c_void, _>(symbol(
                        cf,
                        c"CFStringCreateWithCString",
                    )?),
                    cf_release: std::mem::transmute::<*mut c_void, _>(symbol(cf, c"CFRelease")?),
                })
            }
        })
        .as_ref()
    }

    /// An IOPMAssertion; released on drop.
    pub struct Hold(u32);

    impl Drop for Hold {
        fn drop(&mut self) {
            if let Some(api) = api() {
                // SAFETY: an id IOPMAssertionCreateWithName returned, released once.
                unsafe { (api.release)(self.0) };
            }
        }
    }

    /// `kIOPMAssertPreventUserIdleSystemSleep` named `why`.
    pub async fn take(why: &str) -> Result<Hold, String> {
        let api = api().ok_or("IOKit's power assertions are not available")?;
        let kind = CString::new("PreventUserIdleSystemSleep").expect("no NUL");
        let name = CString::new(why.replace('\0', "")).expect("NULs removed");
        let mut id = 0u32;
        // SAFETY: valid C strings in, CFStrings released after the call, `id` a valid out-pointer.
        let status = unsafe {
            let kind = (api.cf_string)(std::ptr::null(), kind.as_ptr(), UTF8);
            let name = (api.cf_string)(std::ptr::null(), name.as_ptr(), UTF8);
            if kind.is_null() || name.is_null() {
                return Err("cannot make the assertion's name".into());
            }
            let status = (api.create)(kind, LEVEL_ON, name, &mut id);
            (api.cf_release)(kind);
            (api.cf_release)(name);
            status
        };
        if status == 0 {
            Ok(Hold(id))
        } else {
            Err(format!("IOPMAssertionCreateWithName failed ({status:#x})"))
        }
    }

    #[cfg(test)]
    mod tests {
        /// On the CI Mac only: takes a real assertion for a moment and releases it.
        #[tokio::test]
        async fn takes_and_releases_an_assertion() {
            if std::env::var_os("CI").is_none() {
                return;
            }
            let hold = super::take(&super::super::why(2)).await.unwrap();
            drop(hold);
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub struct Hold;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub async fn take(_why: &str) -> Result<Hold, String> {
    Err("this OS has no sleep inhibitor fleetd knows".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn says_how_many_agents_keep_it_awake() {
        assert_eq!(super::why(1), "fleetd: 1 agent running");
        assert_eq!(super::why(3), "fleetd: 3 agents running");
    }
}
