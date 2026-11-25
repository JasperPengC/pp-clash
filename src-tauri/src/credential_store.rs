//! 只在此边界调用平台凭据库；业务代码和测试不接触平台实现。
use serde::Serialize;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Available,
    Unavailable,
    Unsupported,
}

pub trait CredentialStore {
    fn backend(&self) -> &'static str;
    fn read(&self, reference: &str) -> Result<Option<Zeroizing<String>>, Availability>;
    fn write(&self, reference: &str, value: &str) -> Result<(), Availability>;
    fn delete(&self, reference: &str) -> Result<(), Availability>;
}

pub struct PlatformCredentialStore;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl PlatformCredentialStore {
    fn entry(reference: &str) -> Result<keyring::Entry, Availability> {
        keyring::Entry::new("com.ppclash.app.webdav", reference)
            .map_err(|_| Availability::Unavailable)
    }
}

impl CredentialStore for PlatformCredentialStore {
    fn backend(&self) -> &'static str {
        #[cfg(target_os = "macos")]
        {
            "macosKeychain"
        }
        #[cfg(target_os = "windows")]
        {
            "windowsCredentialManager"
        }
        #[cfg(target_os = "linux")]
        {
            "linuxSecretService"
        }
        #[cfg(target_os = "android")]
        {
            "androidKeystore"
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux", target_os = "android")))]
        {
            "unsupported"
        }
    }

    fn read(&self, reference: &str) -> Result<Option<Zeroizing<String>>, Availability> {
        #[cfg(target_os = "android")]
        { return crate::android::cloud_tools::credential("read", reference, ""); }
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            match Self::entry(reference)?.get_password() {
                Ok(value) => Ok(Some(Zeroizing::new(value))),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(Availability::Unavailable),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux", target_os = "android")))]
        {
            let _ = reference;
            Err(Availability::Unsupported)
        }
    }

    fn write(&self, reference: &str, value: &str) -> Result<(), Availability> {
        #[cfg(target_os = "android")]
        { return crate::android::cloud_tools::credential("write", reference, value).map(|_| ()); }
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            Self::entry(reference)?
                .set_password(value)
                .map_err(|_| Availability::Unavailable)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux", target_os = "android")))]
        {
            let _ = (reference, value);
            Err(Availability::Unsupported)
        }
    }

    fn delete(&self, reference: &str) -> Result<(), Availability> {
        #[cfg(target_os = "android")]
        { return crate::android::cloud_tools::credential("delete", reference, "").map(|_| ()); }
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            match Self::entry(reference)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(Availability::Unavailable),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux", target_os = "android")))]
        {
            let _ = reference;
            Err(Availability::Unsupported)
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
    };

    #[derive(Default)]
    pub struct MemoryCredentials {
        pub values: RefCell<HashMap<String, String>>,
        pub fail_write: Cell<bool>,
        pub fail_write_on_call: Cell<usize>,
        pub write_calls: Cell<usize>,
        pub ignore_write: Cell<bool>,
        pub reject_overwrite: Cell<bool>,
        pub fail_delete: Cell<bool>,
        pub read_error: Cell<Option<Availability>>,
        pub read_calls: Cell<usize>,
    }

    impl CredentialStore for MemoryCredentials {
        fn backend(&self) -> &'static str {
            "isolatedMemory"
        }
        fn read(&self, reference: &str) -> Result<Option<Zeroizing<String>>, Availability> {
            self.read_calls.set(self.read_calls.get() + 1);
            if let Some(error) = self.read_error.get() {
                return Err(error);
            }
            Ok(self
                .values
                .borrow()
                .get(reference)
                .cloned()
                .map(Zeroizing::new))
        }
        fn write(&self, reference: &str, value: &str) -> Result<(), Availability> {
            self.write_calls.set(self.write_calls.get() + 1);
            if self.fail_write.replace(false)
                || self.write_calls.get() == self.fail_write_on_call.get()
            {
                return Err(Availability::Unavailable);
            }
            if self.ignore_write.replace(false) {
                return Ok(());
            }
            if self.reject_overwrite.get() && self.values.borrow().contains_key(reference) {
                return Err(Availability::Unavailable);
            }
            self.values
                .borrow_mut()
                .insert(reference.into(), value.into());
            Ok(())
        }
        fn delete(&self, reference: &str) -> Result<(), Availability> {
            if self.fail_delete.replace(false) {
                return Err(Availability::Unavailable);
            }
            self.values.borrow_mut().remove(reference);
            Ok(())
        }
    }
}
