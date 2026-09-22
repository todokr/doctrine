pub mod daemon;
pub mod launch;
pub mod relay;
pub mod settings;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use relay::{Relay, RelayOptions};

/// ソケットの置き場が決められないときも、ウィンドウは出す。
/// ここで panic すると理由が stderr にしか残らず、GUI からは
/// 無言で起動しないようにしか見えない。接続の問題を人に伝える
/// 経路はバナー（daemon-connection / connection_status）で既にあるので、そこに乗せる。
enum RelayState {
    Ready(Arc<Relay>),
    Unavailable(String),
}

/// デーモンへの中継。**method の種類はここでも見ない。**
/// デーモンの API が増えても Rust は変わらない。
#[tauri::command]
async fn rpc(method: String, params: Value, state: State<'_, RelayState>) -> Result<Value, String> {
    let relay = match &*state {
        RelayState::Ready(r) => r.clone(),
        RelayState::Unavailable(e) => return Err(e.clone()),
    };
    relay.call(method, params).await
}

/// 今の接続状態。**画面が起動直後に1度読む。**
/// 接続は setup() の中でミリ秒のうちに終わるので、その時点の daemon-connection は
/// まだ listen していない WebView に届かず捨てられる。これが無いと、画面は
/// データが流れているのに「接続しています…」のままになる。
/// ソケットの置き場が決められなかった場合も、emit ではなくここが唯一の
/// 伝達経路になる（setup 時点では誰も listen していないので emit は無意味）。
#[tauri::command]
fn connection_status(state: State<'_, RelayState>) -> Value {
    match &*state {
        RelayState::Ready(relay) => relay.status(),
        RelayState::Unavailable(reason) => {
            relay::connection_payload("disconnected", Some(reason.clone()))
        }
    }
}

/// 下書きや設定の置き場。アプリを閉じても消えず、OS の「アプリのデータ」の
/// 作法に従う場所に置く（ブラウザの localStorage は WebView を作り直すと消える）。
fn app_data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリのデータディレクトリが決められません: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir.join(name))
}

/// 下書きを読む。ファイルがまだ無いのは正常なので、空として返す。
#[tauri::command]
fn load_drafts(app: AppHandle) -> Result<Value, String> {
    let path = app_data_file(&app, "drafts.json")?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} を読めません: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(format!("{} を読めません: {e}", path.display())),
    }
}

/// 下書きを書く。画面は1打鍵ごとに呼ぶが、このコマンドは async ではないので
/// Tauri が main スレッドで順番に実行する。書き込みが重ならないのはそのため。
/// 一時ファイルに書いてから置き換える。
/// 直接上書きすると、書いている途中で落ちたときに壊れた JSON が残り、
/// 次の起動で下書きを全部失う。
#[tauri::command]
fn save_drafts(app: AppHandle, drafts: Value) -> Result<(), String> {
    let path = app_data_file(&app, "drafts.json")?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(&drafts).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("{} を書けません: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{} を置き換えられません: {e}", path.display()))
}

/// アプリの設定を読む。ファイルが無いときや、キーが欠けているときは既定値で埋める。
#[tauri::command]
fn load_settings(app: AppHandle) -> Result<settings::Settings, String> {
    settings::load(&app_data_file(&app, "settings.json")?)
}

/// アプリの設定を書く。async にしない理由は save_drafts と同じ。
#[tauri::command]
fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<(), String> {
    settings::save(&app_data_file(&app, "settings.json")?, &settings)
}

/// 設定のコマンドに worktree のパスを渡して起動する。終了は待たない。
/// コマンドは画面が設定から読んで渡す。起動の度にファイルを読み直さない。
#[tauri::command]
fn open_path(command: String, path: String) -> Result<(), String> {
    launch::launch(&command, std::path::Path::new(&path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let emit: relay::Emit = Arc::new(move |name: &str, payload: Value| {
                // ウィンドウが閉じている間の emit は失敗しうる。中継を止める理由にはならない。
                let _ = handle.emit(name, payload);
            });
            match daemon::socket_path() {
                Ok(socket) => {
                    let (relay, driver) = Relay::new(socket, emit, RelayOptions::default());
                    // tokio::spawn ではなく Tauri のランタイムに載せる
                    tauri::async_runtime::spawn(driver);
                    app.manage(RelayState::Ready(relay));
                }
                Err(e) => {
                    app.manage(RelayState::Unavailable(e));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            connection_status,
            load_drafts,
            save_drafts,
            load_settings,
            save_settings,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
