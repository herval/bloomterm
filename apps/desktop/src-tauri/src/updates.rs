//! Updates, in release builds only (`--features updater`, which scripts/release.sh builds with).
//! The app checks the releases' latest.json 30 s after launch and every six hours, downloads a
//! newer version in the background, and the menu offers "Restart to Update". The update's
//! signature is checked against the key in tauri.release.conf.json, and must name the version
//! latest.json announces. Restarting stops the bloomd the app started; the new version starts it
//! again. On the Mac RunEvent::Exit does that. On Windows the updater runs the installer and ends
//! the app on the spot, with no RunEvent::Exit, so its on_before_exit does.

use crate::bloomd::Bloomd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(30);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How long "Up to date" or an error stays on the menu item.
const NOTE_FOR: Duration = Duration::from_secs(8);
pub const IDLE: &str = "Check for Updates…";

pub struct Updates {
    item: MenuItem<Wry>,
    /// A downloaded update, waiting for Restart to Update.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    busy: AtomicBool,
}

pub fn init(app: &AppHandle, item: MenuItem<Wry>) {
    app.manage(Updates { item, ready: Mutex::new(None), busy: AtomicBool::new(false) });
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK);
        loop {
            check(&app, false);
            thread::sleep(EVERY);
        }
    });
}

/// The menu item: installs a downloaded update, or checks for one.
pub fn on_click(app: &AppHandle) {
    let app = app.clone();
    // Off the main thread: installing into a folder you can't write asks for an admin password,
    // and the updater waits for the main thread to show that.
    thread::spawn(move || {
        if app.state::<Updates>().ready.lock().unwrap().is_some() {
            install(&app);
        } else {
            check(&app, true);
        }
    });
}

fn check(app: &AppHandle, manual: bool) {
    let u = app.state::<Updates>();
    if u.ready.lock().unwrap().is_some() || u.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    if manual {
        set(&u.item, "Checking for Updates…", false);
    }
    let found = tauri::async_runtime::block_on(async {
        let stopping = app.clone();
        let updater = app.updater_builder().on_before_exit(move || {
            stopping.state::<Arc<Bloomd>>().stop();
            stopping.cleanup_before_exit();
        });
        let Some(update) = updater.build()?.check().await? else { return Ok(None) };
        set(&u.item, &format!("Downloading {}…", update.version), false);
        let bytes = update.download(|_, _| {}, || {}).await?;
        Ok::<_, tauri_plugin_updater::Error>(Some((update, bytes)))
    });
    match found {
        Ok(Some((update, bytes))) => {
            let version = update.version.clone();
            *u.ready.lock().unwrap() = Some((update, bytes));
            set(&u.item, &format!("Restart to Update to {version}"), true);
            if !manual {
                notify(&version);
            }
        }
        Ok(None) if manual => note(&u.item, &format!("bloomterm {} is up to date", app.package_info().version)),
        Ok(None) => set(&u.item, IDLE, true),
        Err(e) => {
            eprintln!("bloomterm: update check failed: {e}");
            if manual {
                note(&u.item, "Couldn't check for updates");
            } else {
                set(&u.item, IDLE, true);
            }
        }
    }
    u.busy.store(false, Ordering::SeqCst);
}

fn install(app: &AppHandle) {
    let u = app.state::<Updates>();
    let Some((update, bytes)) = u.ready.lock().unwrap().take() else { return };
    set(&u.item, &format!("Installing {}…", update.version), false);
    match update.install(&bytes) {
        // RunEvent::Exit stops bloomd, then the app starts again as the new version.
        Ok(()) => app.request_restart(),
        Err(e) => {
            eprintln!("bloomterm: installing {} failed: {e}", update.version);
            // On Windows bloomd and the tray may be gone by now: back to the version you had.
            if cfg!(windows) {
                app.restart();
            }
            note(&u.item, "Couldn't install the update");
        }
    }
}

fn set(item: &MenuItem<Wry>, text: &str, enabled: bool) {
    let _ = item.set_text(text);
    let _ = item.set_enabled(enabled);
}

/// Shows `text` for a few seconds, then goes back to "Check for Updates…".
fn note(item: &MenuItem<Wry>, text: &str) {
    set(item, text, false);
    let item = item.clone();
    thread::spawn(move || {
        thread::sleep(NOTE_FOR);
        set(&item, IDLE, true);
    });
}

/// A notification, once an update is ready. `version` is semver, so it's safe to quote.
#[cfg(not(windows))]
fn notify(version: &str) {
    let script = format!("display notification \"Restart to update from the menu bar.\" with title \"bloomterm {version} is ready\"");
    let _ = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(script).spawn();
}

#[cfg(windows)]
fn notify(version: &str) {
    let _ = tauri_winrt_notification::Toast::new("app.bloomterm.desktop")
        .title(&format!("bloomterm {version} is ready"))
        .text1("Right-click bloomterm in the tray to restart and update.")
        .show();
}
