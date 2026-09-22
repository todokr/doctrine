use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub editor_command: String,
    pub terminal_command: String,
    pub stale_days: u32,
}

impl Default for Settings {
    /// Finder から起動したアプリの PATH には /usr/bin 等しか無い。
    /// `code` のような PATH 頼みのコマンドは配布物で見つからないので、macOS は open を使う。
    fn default() -> Self {
        let (editor_command, terminal_command) = if cfg!(target_os = "macos") {
            ("open -a \"Visual Studio Code\" {path}", "open -a Terminal {path}")
        } else {
            ("xdg-open {path}", "gnome-terminal --working-directory={path}")
        };
        Self {
            editor_command: editor_command.into(),
            terminal_command: terminal_command.into(),
            stale_days: 7,
        }
    }
}

/// 設定を読む。ファイルがまだ無いのは正常なので、既定値を返す。
/// 壊れた JSON は既定値に戻さずエラーにする。黙って戻すと、人が書いた設定が次の保存で消える。
pub fn load(path: &Path) -> Result<Settings, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} を読めません: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

/// 設定を書く。人が手で直すこともあるので整形して書く。
/// 一時ファイルに書いてから置き換えるのは、書いている途中で落ちても壊れた JSON を残さないため。
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("{} を書けません: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{} を置き換えられません: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom() -> Settings {
        Settings {
            editor_command: "code {path}".into(),
            terminal_command: "wezterm start --cwd {path}".into(),
            stale_days: 14,
        }
    }

    #[test]
    fn missing_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let got = load(&dir.path().join("settings.json")).unwrap();
        assert_eq!(got, Settings::default());
        assert_eq!(got.stale_days, 7);
        assert!(got.editor_command.contains("{path}"));
        assert!(got.terminal_command.contains("{path}"));
    }

    #[test]
    fn saved_settings_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save(&path, &custom()).unwrap();
        assert_eq!(load(&path).unwrap(), custom());
    }

    #[test]
    fn save_replaces_existing_file_and_leaves_no_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save(&path, &custom()).unwrap();
        let second = Settings { stale_days: 30, ..custom() };
        save(&path, &second).unwrap();
        assert_eq!(load(&path).unwrap(), second);
        assert!(!dir.path().join("settings.json.tmp").exists());
    }

    #[test]
    fn missing_keys_fall_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"staleDays": 3}"#).unwrap();
        let got = load(&path).unwrap();
        let defaults = Settings::default();
        assert_eq!(got.stale_days, 3);
        assert_eq!(got.editor_command, defaults.editor_command);
        assert_eq!(got.terminal_command, defaults.terminal_command);
    }

    #[test]
    fn broken_json_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{").unwrap();
        let err = load(&path).unwrap_err();
        assert!(err.contains(&path.display().to_string()), "{err}");
    }

    #[test]
    fn keys_are_camel_case_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        save(&path, &custom()).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for key in ["editorCommand", "terminalCommand", "staleDays"] {
            assert!(value.get(key).is_some(), "{key} が無い: {value}");
        }
    }
}
