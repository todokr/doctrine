pub mod daemon;
pub mod relay;

use std::sync::Arc;

use serde_json::Value;
use tauri::{Emitter, Manager, State};

use relay::{Relay, RelayOptions};

/// デーモンへの中継。**method の種類はここでも見ない。**
/// デーモンの API が増えても Rust は変わらない。
#[tauri::command]
async fn rpc(method: String, params: Value, relay: State<'_, Arc<Relay>>) -> Result<Value, String> {
    relay.call(method, params).await
}

/// 今の接続状態。**画面が起動直後に1度読む。**
/// 接続は setup() の中でミリ秒のうちに終わるので、その時点の daemon-connection は
/// まだ listen していない WebView に届かず捨てられる。これが無いと、画面は
/// データが流れているのに「接続しています…」のままになる。
#[tauri::command]
fn connection_status(relay: State<'_, Arc<Relay>>) -> Value {
    relay.status()
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
            let socket = daemon::socket_path().map_err(std::io::Error::other)?;
            let (relay, driver) = Relay::new(socket, emit, RelayOptions::default());
            // tokio::spawn ではなく Tauri のランタイムに載せる
            tauri::async_runtime::spawn(driver);
            app.manage(relay);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc, connection_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
