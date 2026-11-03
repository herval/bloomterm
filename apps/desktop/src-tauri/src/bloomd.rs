//! bloomd, from the app. If one is already running (launchd's, or one in a terminal) the app
//! uses it; otherwise it starts its own: the bundle (scripts/bundle.mjs) on the Node inside the
//! app, with BLOOMTERM_SUPERVISED=1, and starts it again when it exits. Exit code 75 is bloomd
//! asking for that restart (apps/daemon/src/main.ts).

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const RESTART_EXIT: i32 = 75;
/// Node 22 warns that type stripping is experimental each time bloomd loads an integration.
const NODE_FLAG: &str = "--disable-warning=ExperimentalWarning";
/// Exits this close together, other than restarts, and the app stops trying.
const MAX_CRASHES: usize = 3;
const CRASH_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Starting,
    /// Answering on `port`. `ours` when this app started it.
    Running { port: u16, ours: bool },
    /// Stopped, and the app won't start it again until you ask: why, and the end of its log.
    Failed { reason: String, log: String },
}

pub struct Bloomd {
    pub home: PathBuf,
    node: PathBuf,
    bundle: PathBuf,
    child: Mutex<Option<Child>>,
    state: Mutex<State>,
    quitting: AtomicBool,
    retry: AtomicBool,
    on_change: Box<dyn Fn(&State) + Send + Sync>,
}

/// bloomterm's data folder: $BLOOMTERM_HOME, or ~/.bloomterm.
pub fn home() -> PathBuf {
    match std::env::var_os("BLOOMTERM_HOME") {
        Some(h) if !h.is_empty() => PathBuf::from(h),
        _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".bloomterm"),
    }
}

impl Bloomd {
    pub fn new(home: PathBuf, node: PathBuf, bundle: PathBuf, on_change: impl Fn(&State) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Bloomd {
            home,
            node,
            bundle,
            child: Mutex::new(None),
            state: Mutex::new(State::Starting),
            quitting: AtomicBool::new(false),
            retry: AtomicBool::new(false),
            on_change: Box::new(on_change),
        })
    }

    pub fn state(&self) -> State {
        self.state.lock().unwrap().clone()
    }

    fn set(&self, s: State) {
        let mut cur = self.state.lock().unwrap();
        if *cur != s {
            *cur = s.clone();
            drop(cur);
            (self.on_change)(&s);
        }
    }

    /// Keeps bloomd up until the app quits, on a thread of its own.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        thread::spawn(move || me.supervise());
    }

    fn supervise(&self) {
        let mut crashes: Vec<Instant> = Vec::new();
        let mut path: Option<String> = None;
        while !self.quitting.load(Ordering::SeqCst) {
            if let Some(port) = running(&self.home) {
                self.set(State::Running { port, ours: false });
                // Someone else's: watch it, and start ours if it goes away.
                while !self.quitting.load(Ordering::SeqCst) && (health(port) || {
                    thread::sleep(Duration::from_secs(1));
                    health(port)
                }) {
                    thread::sleep(Duration::from_secs(5));
                }
                // It may be restarting (launchd starts it again): give it time before starting ours
                // on its port.
                self.set(State::Starting);
                let back = Instant::now() + Duration::from_secs(15);
                while !self.quitting.load(Ordering::SeqCst) && Instant::now() < back && running(&self.home).is_none() {
                    thread::sleep(Duration::from_millis(500));
                }
                continue;
            }
            self.set(State::Starting);
            let path = path.get_or_insert_with(|| login_path(&self.node));
            let code = match self.run(path) {
                Ok(code) => code,
                Err(reason) => {
                    self.fail(reason);
                    continue;
                }
            };
            if self.quitting.load(Ordering::SeqCst) || code == Some(RESTART_EXIT) {
                continue;
            }
            let now = Instant::now();
            crashes.retain(|t| now.duration_since(*t) < CRASH_WINDOW);
            crashes.push(now);
            if crashes.len() >= MAX_CRASHES {
                crashes.clear();
                let how = code.map_or("was killed".to_string(), |c| format!("exited with code {c}"));
                self.fail(format!("bloomd {how}, {MAX_CRASHES} times in a minute"));
            } else {
                thread::sleep(Duration::from_secs(crashes.len() as u64));
            }
        }
    }

    /// Waits in Failed until Restart bloomd, or quit.
    fn fail(&self, reason: String) {
        self.set(State::Failed { reason, log: log_tail(&self.home, 40) });
        while !self.quitting.load(Ordering::SeqCst) && !self.retry.swap(false, Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(250));
        }
    }

    /// Starts bloomd and waits for it to exit: its exit code (None when killed by a signal).
    fn run(&self, path: &str) -> Result<Option<i32>, String> {
        let bt = self.bundle.join("bt.mjs");
        if !bt.exists() {
            return Err(format!("the app is missing bloomd ({})", bt.display()));
        }
        let logs = self.home.join("logs");
        fs::create_dir_all(&logs).map_err(|e| format!("can't create {}: {e}", logs.display()))?;
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("bloomd.log"))
            .map_err(|e| format!("can't write bloomd's log: {e}"))?;
        if self.quitting.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let _ = writeln!(log, "--- bloomterm.app: starting bloomd");
        let mut child = Command::new(&self.node)
            .arg(NODE_FLAG)
            .arg(&bt)
            .arg("daemon")
            .current_dir(&self.home)
            .env("PATH", path)
            .env("BLOOMTERM_SUPERVISED", "1")
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .spawn()
            .map_err(|e| format!("can't start {}: {e}", self.node.display()))?;
        let pid = child.id();
        let mut up = false;
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return Ok(status.code());
            }
            if !up {
                if let Some(port) = state_file(&self.home).filter(|(p, _)| *p == pid).map(|(_, port)| port).filter(|p| health(*p)) {
                    up = true;
                    self.set(State::Running { port, ours: true });
                }
            }
            // stop() takes it from here when the app quits.
            let mut slot = self.child.lock().unwrap();
            if self.quitting.load(Ordering::SeqCst) {
                *slot = Some(child);
                return Ok(None);
            }
            drop(slot);
            thread::sleep(Duration::from_millis(250));
        }
    }

    /// Restart bloomd: asks it to restart itself (it can when something supervises it), or
    /// tries again after it failed.
    pub fn restart(&self) -> Result<(), String> {
        match self.state() {
            State::Failed { .. } => {
                self.retry.store(true, Ordering::SeqCst);
                Ok(())
            }
            State::Starting => Err("bloomd is starting".into()),
            State::Running { port, .. } => match request(port, "POST", "/api/restart", token(&self.home).as_deref()) {
                Some((202, _)) => Ok(()),
                Some((_, body)) => Err(error_of(&body).unwrap_or_else(|| "bloomd didn't restart".into())),
                None => Err("bloomd didn't answer".into()),
            },
        }
    }

    /// When the app quits: stops bloomd if the app started it (SIGTERM, then SIGKILL after 8s).
    pub fn stop(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        // The supervisor hands the child over within 250ms.
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut child = loop {
            if let Some(c) = self.child.lock().unwrap().take() {
                break Some(c);
            }
            if !matches!(self.state(), State::Running { ours: true, .. } | State::Starting) || Instant::now() > deadline {
                break None;
            }
            thread::sleep(Duration::from_millis(50));
        };
        if let Some(c) = child.as_mut() {
            unsafe { libc::kill(c.id() as libc::pid_t, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = c.try_wait() {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// A one-time sign-in link to bloomd's web app, like `bt ui`.
    pub fn sign_in_url(&self, port: u16) -> Result<String, String> {
        let token = token(&self.home).ok_or_else(|| format!("no API token in {}", self.home.join("token").display()))?;
        match request(port, "POST", "/api/ui/code", Some(&token)) {
            Some((200, body)) => {
                let code = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v["code"].as_str().map(String::from));
                code.map(|c| format!("http://127.0.0.1:{port}/#code={c}")).ok_or_else(|| "bloomd sent no sign-in code".into())
            }
            Some((_, body)) => Err(error_of(&body).unwrap_or_else(|| "bloomd refused a sign-in code".into())),
            None => Err("bloomd didn't answer".into()),
        }
    }
}

/// The bloomd this home's state file names, if it answers as bloomd.
fn running(home: &Path) -> Option<u16> {
    state_file(home).map(|(_, port)| port).filter(|p| health(*p))
}

/// state/bloomd.json: (pid, port).
fn state_file(home: &Path) -> Option<(u32, u16)> {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(home.join("state/bloomd.json")).ok()?).ok()?;
    Some((v["pid"].as_u64()? as u32, v["port"].as_u64()? as u16))
}

/// Another server can hold the port once bloomd is gone; bloomd says its name.
fn health(port: u16) -> bool {
    matches!(request(port, "GET", "/api/health", None), Some((200, body)) if body.contains("\"name\":\"bloomd\""))
}

fn token(home: &Path) -> Option<String> {
    fs::read_to_string(home.join("token")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

fn error_of(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body).ok()?["error"].as_str().map(String::from)
}

/// One request to bloomd on 127.0.0.1 (HTTP/1.1, no body, connection closed after): status and body.
fn request(port: u16, method: &str, path: &str, token: Option<&str>) -> Option<(u16, String)> {
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    write!(s, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Content-Length: 0\r\nConnection: close\r\n\r\n").ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    Some((status, if chunked { dechunk(body) } else { body.to_string() }))
}

fn dechunk(mut body: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = body.split_once("\r\n") {
        let n = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        if n == 0 || rest.len() < n {
            break;
        }
        out.push_str(&rest[..n]);
        body = rest[n..].trim_start_matches("\r\n");
    }
    out
}

/// The PATH your login shell sets up, so bloomd finds `claude` or `codex` (and the `node` an npm
/// install of them runs on); apps opened from the Finder get only /usr/bin:/bin:/usr/sbin:/sbin.
/// The app's own Node comes last, for agent CLIs that need one when you have none.
fn login_path(node: &Path) -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    const MARK: &str = "__BLOOMTERM_PATH__";
    let found = output_within(Command::new(shell).args(["-ilc", &format!("printf '\\n{MARK}%s\\n' \"$PATH\"")]), Duration::from_secs(6))
        .and_then(|out| out.lines().find_map(|l| l.strip_prefix(MARK).map(String::from)))
        .filter(|p| !p.is_empty());
    let mut dirs: Vec<String> = found.unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into()).split(':').map(String::from).collect();
    for d in ["/opt/homebrew/bin", "/usr/local/bin"].iter().map(|s| s.to_string()).chain(node.parent().map(|p| p.display().to_string())) {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs.join(":")
}

/// A command's stdout, or None if it fails or takes longer than `limit`.
fn output_within(cmd: &mut Command, limit: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return reader.join().ok().filter(|_| status.success()),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The last lines of bloomd's log.
fn log_tail(home: &Path, lines: usize) -> String {
    let text = fs::read(home.join("logs/bloomd.log")).unwrap_or_default();
    let text = String::from_utf8_lossy(&text[text.len().saturating_sub(16 * 1024)..]).to_string();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dechunks() {
        assert_eq!(dechunk("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"), "hello world");
        assert_eq!(dechunk("0\r\n\r\n"), "");
    }

    #[test]
    fn reads_the_state_file() {
        let dir = std::env::temp_dir().join(format!("bt-desktop-{}", std::process::id()));
        fs::create_dir_all(dir.join("state")).unwrap();
        fs::write(dir.join("state/bloomd.json"), r#"{"pid":42,"port":4321,"startedAt":"x"}"#).unwrap();
        assert_eq!(state_file(&dir), Some((42, 4321)));
        fs::write(dir.join("token"), "abc\n").unwrap();
        assert_eq!(token(&dir).as_deref(), Some("abc"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finds_a_login_path() {
        let p = login_path(Path::new("/Applications/bloomterm.app/Contents/MacOS/node"));
        assert!(p.contains("/usr/bin"), "{p}");
        assert!(p.ends_with("/Applications/bloomterm.app/Contents/MacOS"), "{p}");
    }
}
