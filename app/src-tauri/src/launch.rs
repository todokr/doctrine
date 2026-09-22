use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// POSIX のシングルクォートで囲む。ダブルクォートだと `$` やバッククォートが展開される。
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `command` の `{path}` をすべて、クォートした `path` に置き換える。
pub fn render_command(command: &str, path: &str) -> String {
    command.replace("{path}", &shell_quote(path))
}

/// 設定されたコマンドに worktree のパスを渡して起動する。終了は待たない。
/// コマンドが見つからない（sh の終了コード 127）ことは、待たない以上ここには出ない。
pub fn launch(command: &str, path: &Path) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("起動コマンドが設定されていません".into());
    }
    // worktree が既に削除されているときはここへ来る
    if !path.is_dir() {
        return Err(format!("ディレクトリがありません: {}", path.display()));
    }
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("パスが UTF-8 ではありません: {}", path.display()))?;
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(render_command(command, path_str))
        .current_dir(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("{command} を起動できません: {e}"))?;
    // Child を捨てると、子が終わってもアプリが終わるまでゾンビが残る
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn path_placeholder_is_replaced_with_quoted_path() {
        assert_eq!(render_command("code {path}", "/tmp/wt"), "code '/tmp/wt'");
    }

    #[test]
    fn quotes_spaces_and_single_quotes() {
        assert_eq!(
            render_command("code {path}", "/tmp/a b/it's"),
            "code '/tmp/a b/it'\\''s'"
        );
    }

    #[test]
    fn shell_metacharacters_are_not_expanded() {
        assert_eq!(render_command("x {path}", "/tmp/$(id)"), "x '/tmp/$(id)'");
    }

    #[test]
    fn every_placeholder_is_replaced() {
        assert_eq!(render_command("a {path} b {path}", "/p"), "a '/p' b '/p'");
    }

    #[test]
    fn command_without_placeholder_is_kept() {
        assert_eq!(render_command("x-terminal-emulator", "/p"), "x-terminal-emulator");
    }

    #[test]
    fn missing_directory_is_an_error() {
        let err = launch("true", Path::new("/nope/doctrine-missing")).unwrap_err();
        assert!(err.contains("/nope/doctrine-missing"), "{err}");
    }

    #[test]
    fn file_is_not_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, "").unwrap();
        assert!(launch("true", &file).is_err());
    }

    #[test]
    fn empty_command_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(launch("  ", dir.path()).is_err());
    }

    #[test]
    fn launches_command_with_quoted_path() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("a b's");
        std::fs::create_dir(&dir).unwrap();

        launch("touch {path}/launched", &dir).unwrap();

        let marker = dir.join("launched");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(marker.exists());
    }
}
