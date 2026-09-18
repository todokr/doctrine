use std::env;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

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

/// DB・ログ・（macOS では）ソケットの置き場。`src/util/home.ts` の stateRoot と同じ規則。
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

/// `src/daemon/server.ts` の resolveSocketPath と同じ規則。**両方を直すこと。**
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
}
