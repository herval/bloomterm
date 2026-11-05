//! bloomterm's desktop app (SPEC §8.7): a window on bloomd's web app, and a menu bar or tray item
//! that keeps bloomd running while the window is closed. Quitting the app stops the bloomd it
//! started.

// Without this, Windows opens a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bloomd;
#[cfg(feature = "updater")]
mod updates;

use bloomd::{Bloomd, State};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// The app's own page (shell/index.html): "Starting bloomd…", or why it stopped. Windows serves the
/// app's files from a made-up http host.
const STATUS_PAGE: &str = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };

/// The port of the bloomd the window shows, or None while it shows the status page.
struct View(Mutex<Option<u16>>);

struct Tray {
    status: MenuItem<Wry>,
    login: CheckMenuItem<Wry>,
}

fn main() {
    // Open at Login starts the app with --hidden: bloomd and the menu bar item, no window.
    let hidden = std::env::args().any(|a| a == "--hidden");
    // --quit does what Quit in the menu does, to the app that's running.
    let quit = std::env::args().any(|a| a == "--quit");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|a| a == "--quit") {
                app.exit(0);
            } else {
                show(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])));
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    // The Mac's menu bar. On Windows this would be a strip of File, Edit and View across the window.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(Menu::default);
    let app = builder
        .setup(move |app| {
            // There was no app to quit, or the second-instance plugin would have ended this one.
            if quit {
                std::process::exit(0);
            }
            let handle = app.handle().clone();
            app.manage(View(Mutex::new(None)));
            let w = window(&handle)?;
            if !hidden {
                w.show()?;
            }
            tray(&handle)?;
            let node = std::env::current_exe()?.with_file_name(if cfg!(windows) { "node.exe" } else { "node" });
            let bundle = app.path().resource_dir()?.join("bundle");
            let on_change = handle.clone();
            let bloomd = Bloomd::new(bloomd::home(), node, bundle, move |s| on_state(&on_change, s));
            app.manage(bloomd.clone());
            bloomd.start();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("bloomterm couldn't start");
    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        RunEvent::Exit => app.state::<Arc<Bloomd>>().stop(),
        _ => {}
    });
}

fn window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("bloomterm")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 640.0)
        .visible(false)
        // Files dropped on Ask go to the page, not to Tauri.
        .disable_drag_drop_handler()
        // The web app saves downloads through bloomd here, and words a few things for the app.
        .initialization_script("window.__BLOOMTERM_DESKTOP__ = true;")
        // The window shows bloomd and the status page; links anywhere else open in your browser.
        .on_navigation(|url| {
            let ours = match url.scheme() {
                "tauri" | "about" => true,
                "http" => url.host_str() == Some("127.0.0.1") || (cfg!(windows) && url.host_str() == Some("tauri.localhost")),
                _ => false,
            };
            if !ours {
                open_outside(url);
            }
            ours
        })
        .on_new_window(|url, _| {
            open_outside(&url);
            NewWindowResponse::Deny
        })
        .build()?;
    // Closing the window hides it; bloomd keeps running, in the menu bar.
    let hide = w.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = hide.hide();
        }
    });
    Ok(w)
}

fn open_outside(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }
    #[cfg(windows)]
    let mut open = {
        let windows = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let mut open = std::process::Command::new(std::path::Path::new(&windows).join("System32").join("rundll32.exe"));
        open.arg("url.dll,FileProtocolHandler");
        open
    };
    #[cfg(not(windows))]
    let mut open = std::process::Command::new("/usr/bin/open");
    let _ = open.arg(url.as_str()).spawn();
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let status = MenuItem::with_id(app, "status", "bloomd: starting…", false, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Open at Login", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &item("open", "Open bloomterm")?,
            &item("ask", "Ask…")?,
            &item("sources", "Sources")?,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &item("restart", "Restart bloomd")?,
            &login,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", "Quit bloomterm")?,
        ],
    )?;
    #[cfg(feature = "updater")]
    {
        let update = item("update", updates::IDLE)?;
        menu.insert(&update, 7)?;
        updates::init(app, update);
    }
    // The Mac tints its template icon to suit the menu bar. Windows would show it black on a dark taskbar.
    let icon: &[u8] = if cfg!(windows) { include_bytes!("../icons/32x32.png") } else { include_bytes!("../tray/icon.png") };
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(icon)?)
        .icon_as_template(true)
        .tooltip("bloomterm")
        .menu(&menu)
        // On Windows a click opens the app, and a right click the menu.
        .show_menu_on_left_click(cfg!(not(windows)))
        .on_tray_icon_event(|tray, e| {
            if cfg!(windows) && matches!(e, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                show(tray.app_handle());
            }
        })
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .build(app)?;
    app.manage(Tray { status, login });
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show(app),
        "ask" => {
            show(app);
            send(app, "{ ask: true }");
        }
        "sources" => {
            show(app);
            send(app, "{ go: '/sources' }");
        }
        "restart" => {
            let app = app.clone();
            thread::spawn(move || {
                if let Err(e) = app.state::<Arc<Bloomd>>().restart() {
                    let _ = app.state::<Tray>().status.set_text(format!("bloomd: {e}"));
                }
            });
        }
        "login" => {
            let auto = app.autolaunch();
            let _ = if auto.is_enabled().unwrap_or(false) { auto.disable() } else { auto.enable() };
            let _ = app.state::<Tray>().login.set_checked(auto.is_enabled().unwrap_or(false));
        }
        #[cfg(feature = "updater")]
        "update" => updates::on_click(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Tells the web app to open Ask or a page (apps/web/src/Shell.tsx listens).
fn send(app: &AppHandle, detail: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('bloomterm:desktop', {{ detail: {detail} }}))"));
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // If the page was signed out, sign it in again (codes last a minute, so a fresh one).
    let port = *app.state::<View>().0.lock().unwrap();
    if let Some(port) = port {
        let app = app.clone();
        thread::spawn(move || {
            let Ok(url) = app.state::<Arc<Bloomd>>().sign_in_url(port) else { return };
            let Some(code) = url.split_once('#').map(|(_, c)| c.to_string()) else { return };
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(format!("if (!localStorage.getItem('bloomterm.token')) location.hash = {}", serde_json::json!(code)));
            }
        });
    }
}

/// bloomd changed: the menu says so, and the window goes to it or to the status page.
fn on_state(app: &AppHandle, s: &State) {
    let _ = app.state::<Tray>().status.set_text(match s {
        State::Starting => "bloomd: starting…".to_string(),
        State::Running { port, ours: true } => format!("bloomd: running on :{port}"),
        State::Running { port, ours: false } => format!("bloomd: running on :{port}, started outside the app"),
        State::Failed { .. } => "bloomd: stopped".to_string(),
    });
    let Some(w) = app.get_webview_window("main") else { return };
    let shown = *app.state::<View>().0.lock().unwrap();
    match s {
        // On a restart the web app shows that it's reconnecting, and picks up where it was.
        State::Starting if shown.is_none() => status(app, &w, "Starting bloomd…", false, ""),
        State::Starting => {}
        State::Running { port, .. } if shown == Some(*port) => {}
        State::Running { port, .. } => match app.state::<Arc<Bloomd>>().sign_in_url(*port).map(|u| u.parse::<Url>()) {
            Ok(Ok(url)) => {
                *app.state::<View>().0.lock().unwrap() = Some(*port);
                let _ = w.navigate(url);
            }
            Ok(Err(e)) => status(app, &w, &e.to_string(), true, ""),
            Err(e) => status(app, &w, &e, true, ""),
        },
        State::Failed { reason, log } => status(app, &w, reason, true, log),
    }
}

fn status(app: &AppHandle, w: &WebviewWindow, text: &str, error: bool, detail: &str) {
    *app.state::<View>().0.lock().unwrap() = None;
    let mut url = Url::parse(STATUS_PAGE).expect("status page URL");
    url.query_pairs_mut().append_pair("s", &serde_json::json!({ "text": text, "error": error, "detail": detail }).to_string());
    let _ = w.navigate(url);
}
