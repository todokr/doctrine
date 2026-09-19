use std::env;
use std::fs::OpenOptions;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

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
    Err("dctld が見つかりません（deno task install で入ります）".into())
}

pub fn find_dctld() -> Result<PathBuf, String> {
    find_dctld_in(env::var("DOCTRINE_DCTLD").ok(), env::var("PATH").ok())
}

/// 状態ディレクトリを 0o700 で作る。
///
/// ここが緩いと、後から dctld が mode: 0o700 で mkdir しても手遅れになる
/// （既にあるディレクトリのパーミッションは mkdir では変わらない）。
/// doctrine は TCP ポートを開かず、ファイルパーミッションがそのまま認可に
/// なるので（core/src/daemon/server.ts）、DB・ログ・ソケットの置き場を
/// 他人から読めるまま作ってはいけない。
/// 既に存在するディレクトリのモードは（Deno 側と同様）変更しない。
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
pub fn spawn_dctld() -> Result<Child, String> {
    let bin = find_dctld()?;
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

    Command::new(&bin)
        .process_group(0) // Ctrl-C は前面プロセスグループ全体に届く。そこから抜ける
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .spawn()
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
        assert!(err.contains("deno task install"), "案内が無い: {err}");
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
}
