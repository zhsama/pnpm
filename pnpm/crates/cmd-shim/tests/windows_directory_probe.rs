#![cfg(windows)]

use pnpm_cmd_shim::remove_bin;
use pnpm_fs::test_support::with_file_removal_observer;
use std::{
    fs,
    sync::{Arc, Mutex},
    time::Instant,
};
use tempfile::tempdir;

// Fork-only measurement of the existing policy, not a latency contract.
#[test]
fn measure_permanent_directory_error() {
    let root = tempdir().unwrap();
    let path = root.path().join("occupied-bin");
    fs::create_dir(&path).unwrap();
    let child = path.join("must-survive");
    fs::write(&child, "preserved").unwrap();
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&attempts);
    let started = Instant::now();
    let result = with_file_removal_observer(
        &path,
        move |attempt| {
            observed
                .lock()
                .unwrap()
                .push(attempt.as_ref().err().and_then(std::io::Error::raw_os_error));
        },
        || remove_bin(&path),
    );
    let elapsed = started.elapsed();
    let attempts = attempts.lock().unwrap();
    let error = result.expect_err("a directory occupying a bin must not be removed");
    assert!(!attempts.is_empty());
    assert_eq!(fs::read_to_string(child).unwrap(), "preserved");
    eprintln!(
        "PERMANENT_DIRECTORY: elapsed={elapsed:?}, attempts={}, first_os_error={:?}, final_error={error:?}",
        attempts.len(),
        attempts.first(),
    );
}
