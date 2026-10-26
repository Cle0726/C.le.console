//! Compile and exercise the production storage/coordination modules without
//! linking the desktop UI. Tests use synthetic accounts in temporary folders.
#![allow(dead_code)]

#[path = "../../../src-tauri/src/modules/account_singleflight.rs"]
mod account_singleflight;
#[path = "../../../src-tauri/src/modules/atomic_write.rs"]
pub mod atomic_write;
#[path = "../../../src-tauri/src/modules/credential_store.rs"]
mod credential_store;

pub mod modules {
    pub use crate::atomic_write;
    pub mod logger {
        pub fn log_warn(_: &str) {}
    }
}
