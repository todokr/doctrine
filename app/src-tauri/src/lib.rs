pub mod daemon;
pub mod relay;

use std::sync::Arc;

use serde_json::Value;
use tauri::{Emitter, Manager, State};

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
        .invoke_handler(tauri::generate_handler![rpc, connection_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
