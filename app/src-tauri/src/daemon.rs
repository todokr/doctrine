use std::env;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Macos,
    Linux,
}

/// 解決する前の生の環境。**状態ディレクトリをここで解決しない。**
/// 解決は macOS の分岐でしか要らず、先に解決すると XDG_RUNTIME_DIR はあるが
/// HOME が無い環境で、繋がるはずの経路まで落ちる。
pub struct PathEnv {
    pub doctrine_socket: Option<String>,
    pub xdg_runtime_dir: Option<String>,
    /// DOCTRINE_STATE_DIR
    pub state_dir: Option<String>,
    /// HOME
    pub home: Option<String>,
    pub uid: u32,
    pub os: Os,
}

/// DB・ログ・（macOS では）ソケットの置き場。`core/src/util/home.ts` の stateRoot と同じ規則。
pub fn resolve_state_root(
    state_dir: Option<String>,
    home: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(d) = state_dir.filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(d));
    }
    let home = home
        .filter(|s| !s.is_empty())
        .ok_or("HOME が設定されていません（DOCTRINE_STATE_DIR を指定してください）")?;
    Ok(Path::new(&home)
        .join(".local")
        .join("state")
        .join("doctrine"))
}

/// `core/src/daemon/server.ts` の resolveSocketPath と同じ規則。**両方を直すこと。**
/// 片方だけ直すと、症状は「繋がらない」としか出ない。
pub fn resolve_socket_path(env: &PathEnv) -> Result<PathBuf, String> {
    if let Some(p) = env.doctrine_socket.as_deref().filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    if let Some(x) = env.xdg_runtime_dir.as_deref().filter(|s| !s.is_empty()) {
        return Ok(Path::new(x).join("doctrine").join("dctld.sock"));
    }
    match env.os {
        // macOS には XDG_RUNTIME_DIR が無く /run は read-only。
        // 状態ディレクトリの解決（HOME を要る）はこの枝に入ってから
        Os::Macos => {
            Ok(resolve_state_root(env.state_dir.clone(), env.home.clone())?.join("dctld.sock"))
        }
        Os::Linux => Ok(Path::new(&format!("/run/user/{}", env.uid))
            .join("doctrine")
            .join("dctld.sock")),
    }
}

pub fn current_env() -> PathEnv {
    PathEnv {
        doctrine_socket: env::var("DOCTRINE_SOCKET").ok(),
        xdg_runtime_dir: env::var("XDG_RUNTIME_DIR").ok(),
        state_dir: env::var("DOCTRINE_STATE_DIR").ok(),
        home: env::var("HOME").ok(),
        // libc を足さずに実 uid を取る。macOS には /proc が無いが、
        // macOS の分岐は uid を見ないので既定値で構わない。
        uid: std::fs::metadata("/proc/self")
            .map(|m| m.uid())
            .unwrap_or(1000),
        os: if cfg!(target_os = "macos") {
            Os::Macos
        } else {
            Os::Linux
        },
    }
}

pub fn socket_path() -> Result<PathBuf, String> {
    resolve_socket_path(&current_env())
}

/// 探索の規則そのもの。環境変数を読まないのでテストできる。
pub fn find_dctld_in(explicit: Option<String>, path: Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = explicit.filter(|s| !s.is_empty()) {
        let p = PathBuf::from(p);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!(
                "DOCTRINE_DCTLD が指すファイルがありません: {}",
                p.display()
            ))
        };
    }
    for dir in env::split_paths(&path.unwrap_or_default()) {
        let candidate = dir.join("dctld");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("dctld が見つかりません（mise run core:install で入ります）".into())
}

pub fn find_dctld(path: Option<String>) -> Result<PathBuf, String> {
    find_dctld_in(env::var("DOCTRINE_DCTLD").ok(), path)
}

const PATH_MARKER: &str = "__DOCTRINE_PATH__";

/// ログインシェルの出力から、PATH_MARKER に挟まれた PATH を取り出す。
/// シェルが 0 以外で終わった・区切りが揃わない・中身が空のときは None。
fn extract_login_path(stdout: &[u8], success: bool) -> Option<String> {
    if !success {
        return None;
    }
    let text = String::from_utf8_lossy(stdout);
    let start = text.find(PATH_MARKER)? + PATH_MARKER.len();
    let len = text[start..].find(PATH_MARKER)?;
    let path = &text[start..start + len];
    (!path.is_empty()).then(|| path.to_string())
}

/// `shell -l -c script` を走らせ、`timeout` までにシェルが終わり stdout も読み終えれば
/// (成功したか, stdout) を返す。起動できない・締め切りを過ぎたら None。
fn run_login_shell(shell: &str, script: &str, timeout: Duration) -> Option<(bool, Vec<u8>)> {
    let deadline = Instant::now() + timeout;
    let mut child = Command::new(shell)
        .arg("-l")
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // 読み取りスレッドは join しない。.zprofile が stdout を継いだ孫を常駐させると
    // シェルが終わってもパイプの書き込み側が閉じず、read_to_end が戻らない。
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let mut stdout = child.stdout.take()?;
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };

    let out = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()?;
    Some((status.success(), out))
}

/// dctld に渡す PATH を、ログインシェル（$SHELL、無ければ /bin/zsh）から読む。読めなければ None。
fn login_shell_path() -> Option<String> {
    let shell = env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let script = format!("printf '{PATH_MARKER}%s{PATH_MARKER}' \"$PATH\"");
    let (success, stdout) = run_login_shell(&shell, &script, Duration::from_secs(3))?;
    extract_login_path(&stdout, success)
}

/// 状態ディレクトリを 0o700 で作る。
///
/// ここが緩いと、後から dctld が mode: 0o700 で mkdir しても手遅れになる
/// （既にあるディレクトリのパーミッションは mkdir では変わらない）。
/// doctrine は TCP ポートを開かず、ファイルパーミッションがそのまま認可に
/// なるので（core/src/daemon/server.ts）、DB・ログ・ソケットの置き場を
/// 他人から読めるまま作ってはいけない。
/// 既に存在するディレクトリのモードは（core 側と同様）変更しない。
fn ensure_state_dir(root: &Path) -> Result<(), String> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)
        .map_err(|e| format!("状態ディレクトリを作れません ({}): {e}", root.display()))
}

/// dctld を切り離して起動する。アプリを終了しても、ターミナルで Ctrl-C しても残る。
///
/// **Child を返すこと。** 捨てると2つの問題が同時に起きる。(1) dctld が listen する
/// までに時間がかかると、呼び出し側が「まだソケットが無い」と見てもう1つ起動し、
/// どちらも assertSocketNotLive を素通りして**同じ DB に2つのデーモンが書く**
/// （まさに assertSocketNotLive が防ごうとしている事態）。(2) dctld が先に死ぬと
/// ゾンビが残る。呼び出し側が Child を持ち、try_wait() で生死を見て両方を防ぐ。
///
/// Finder から起動したアプリの PATH には /usr/bin などしか無く、dctld も、dctld が呼ぶ
/// claude / gh / git も見えない。ログインシェルの PATH を、探索と子の環境にだけ使う。
pub fn spawn_dctld() -> Result<Child, String> {
    let login_path = login_shell_path();
    let bin = find_dctld(login_path.clone().or_else(|| env::var("PATH").ok()))?;
    let e = current_env();
    let root = resolve_state_root(e.state_dir, e.home)?;
    ensure_state_dir(&root)?;

    // 切り離すと stdout / stderr の行き先が無くなる。dctld は起動時の復帰結果・
    // 孤児の検出・tick の失敗をここにしか書かないので、捨てずにログへ追記する。
    let log_path = root.join("dctld.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_path)
        .map_err(|e| format!("ログを開けません ({}): {e}", log_path.display()))?;
    let err = log
        .try_clone()
        .map_err(|e| format!("ログを複製できません: {e}"))?;

    let mut cmd = Command::new(&bin);
    cmd.process_group(0) // Ctrl-C は前面プロセスグループ全体に届く。そこから抜ける
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err));
    if let Some(p) = &login_path {
        cmd.env("PATH", p);
    }
    cmd.spawn()
        .map_err(|e| format!("dctld を起動できません ({}): {e}", bin.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(os: Os) -> PathEnv {
        PathEnv {
            doctrine_socket: None,
            xdg_runtime_dir: None,
            state_dir: None,
            home: Some("/home/u".into()),
            uid: 501,
            os,
        }
    }

    #[test]
    fn doctrine_socket_wins() {
        let mut e = env(Os::Linux);
        e.doctrine_socket = Some("/tmp/x.sock".into());
        e.xdg_runtime_dir = Some("/run/user/1".into());
        assert_eq!(
            resolve_socket_path(&e).unwrap(),
            PathBuf::from("/tmp/x.sock")
        );
    }

    #[test]
    fn xdg_runtime_dir_is_used_on_both_os() {
        let mut e = env(Os::Macos);
        e.xdg_runtime_dir = Some("/run/user/501".into());
        assert_eq!(
            resolve_socket_path(&e).unwrap(),
            PathBuf::from("/run/user/501/doctrine/dctld.sock")
        );
    }

    #[test]
    fn linux_falls_back_to_run_user() {
        assert_eq!(
            resolve_socket_path(&env(Os::Linux)).unwrap(),
            PathBuf::from("/run/user/501/doctrine/dctld.sock")
        );
    }

    #[test]
    fn macos_falls_back_to_state_root() {
        // macOS には XDG_RUNTIME_DIR が無く /run は read-only
        assert_eq!(
            resolve_socket_path(&env(Os::Macos)).unwrap(),
            PathBuf::from("/home/u/.local/state/doctrine/dctld.sock")
        );
    }

    #[test]
    fn state_root_is_only_resolved_on_the_macos_branch() {
        // 先に解決すると、XDG_RUNTIME_DIR はあるが HOME が無い環境で
        // 繋がるはずの経路まで落ちる
        let mut e = env(Os::Linux);
        e.home = None;
        e.xdg_runtime_dir = Some("/run/user/501".into());
        assert!(resolve_socket_path(&e).is_ok());

        let mut e = env(Os::Macos);
        e.home = None;
        assert!(resolve_socket_path(&e).is_err());
    }

    #[test]
    fn empty_state_dir_is_treated_as_unset() {
        assert_eq!(
            resolve_state_root(Some("".into()), Some("/home/u".into())).unwrap(),
            PathBuf::from("/home/u/.local/state/doctrine")
        );
    }

    #[test]
    fn state_root_prefers_explicit_dir() {
        assert_eq!(
            resolve_state_root(Some("/x".into()), Some("/home/u".into())).unwrap(),
            PathBuf::from("/x")
        );
        assert_eq!(
            resolve_state_root(None, Some("/home/u".into())).unwrap(),
            PathBuf::from("/home/u/.local/state/doctrine")
        );
        assert!(resolve_state_root(None, None).is_err());
    }

    #[test]
    fn finds_dctld_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("dctld");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let found = find_dctld_in(None, Some(dir.path().to_string_lossy().into_owned()));
        assert_eq!(found.unwrap(), bin);
    }

    #[test]
    fn explicit_override_wins() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("mydctld");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let found = find_dctld_in(Some(bin.to_string_lossy().into_owned()), None);
        assert_eq!(found.unwrap(), bin);
    }

    #[test]
    fn missing_dctld_says_how_to_install() {
        let dir = tempfile::tempdir().unwrap();
        let err = find_dctld_in(None, Some(dir.path().to_string_lossy().into_owned())).unwrap_err();
        assert!(err.contains("mise run core:install"), "案内が無い: {err}");
    }

    #[test]
    fn explicit_override_that_is_missing_is_an_error() {
        let err = find_dctld_in(Some("/nope/dctld".into()), None).unwrap_err();
        assert!(
            err.contains("DOCTRINE_DCTLD"),
            "どの設定が悪いか分からない: {err}"
        );
    }

    #[test]
    fn state_dir_is_created_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("nested").join("doctrine");
        ensure_state_dir(&root).unwrap();
        let mode = std::fs::metadata(&root).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "状態ディレクトリが他人から読める: {mode:o}");
    }

    #[test]
    fn extracts_path_between_markers() {
        let out = b"__DOCTRINE_PATH__/opt/homebrew/bin:/usr/bin__DOCTRINE_PATH__";
        assert_eq!(
            extract_login_path(out, true).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn extracts_path_surrounded_by_shell_noise() {
        let out = b"Last login: ...\nwelcome\n__DOCTRINE_PATH__/a:/b__DOCTRINE_PATH__\nbye\n";
        assert_eq!(extract_login_path(out, true).as_deref(), Some("/a:/b"));
    }

    #[test]
    fn missing_marker_is_none() {
        assert_eq!(extract_login_path(b"/usr/bin:/bin", true), None);
        assert_eq!(extract_login_path(b"__DOCTRINE_PATH__/usr/bin", true), None);
    }

    #[test]
    fn empty_path_is_none() {
        assert_eq!(
            extract_login_path(b"__DOCTRINE_PATH____DOCTRINE_PATH__", true),
            None
        );
    }

    #[test]
    fn failed_shell_is_none() {
        assert_eq!(
            extract_login_path(b"__DOCTRINE_PATH__/a__DOCTRINE_PATH__", false),
            None,
            "終了コードが 0 以外なのに出力を使っている"
        );
    }

    #[test]
    fn nonexistent_shell_is_none() {
        assert!(run_login_shell("/nope/doctrine-shell", "true", Duration::from_secs(3)).is_none());
    }

    #[test]
    fn runs_login_shell_and_reads_path() {
        let script = format!("printf '{PATH_MARKER}%s{PATH_MARKER}' /x:/y");
        let (success, stdout) =
            run_login_shell("/bin/sh", &script, Duration::from_secs(5)).expect("シェルが走らない");
        assert_eq!(
            extract_login_path(&stdout, success).as_deref(),
            Some("/x:/y")
        );
    }

    #[test]
    fn nonzero_exit_is_reported() {
        let r = run_login_shell("/bin/sh", "printf x; exit 3", Duration::from_secs(5));
        assert!(matches!(r, Some((false, _))), "失敗が伝わらない");
    }

    #[test]
    fn shell_that_hangs_times_out() {
        let start = Instant::now();
        let r = run_login_shell("/bin/sh", "exec sleep 10", Duration::from_millis(200));
        assert!(r.is_none());
        assert!(start.elapsed() < Duration::from_secs(5), "締め切りで戻らない");
    }

    #[test]
    fn grandchild_holding_stdout_does_not_block() {
        let start = Instant::now();
        let r = run_login_shell("/bin/sh", "sleep 10 & printf ok", Duration::from_millis(500));
        assert!(r.is_none());
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "孫が stdout を握ると戻らない"
        );
    }
}
