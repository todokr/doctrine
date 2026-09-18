use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

use crate::daemon;

/// 中継がフロントエンドへ出す口。Tauri の AppHandle を relay.rs に持ち込まないための注入点。
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Clone)]
pub struct RelayOptions {
    pub request_timeout: Duration,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
    /// ソケットが無いときに dctld を起こすか。テストは false
    pub spawn_daemon: bool,
    /// dctld を起こしてからソケットが現れるまで待つ上限
    pub spawn_grace: Duration,
}

impl Default for RelayOptions {
    fn default() -> Self {
        RelayOptions {
            // dctl の REQUEST_TIMEOUT_MS と揃える
            request_timeout: Duration::from_secs(30),
            backoff_initial: Duration::from_millis(500),
            backoff_max: Duration::from_secs(30),
            spawn_daemon: true,
            spawn_grace: Duration::from_secs(5),
        }
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Relay {
    next_id: AtomicU64,
    pending: Pending,
    /// 接続中だけ Some。切れている間の call はここで弾く
    writer: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    /// 最後に emit した接続状態。**イベントだけだと WebView が間に合わない。**
    /// setup() の接続はミリ秒で終わるが、その時点で listen() を呼んでいる購読者は
    /// 居ないので connected のイベントは捨てられ、画面は「接続しています…」の
    /// ままになる。画面は購読を張った後でここを1度読んで追いつく。
    status: Arc<Mutex<Value>>,
    options: RelayOptions,
}

impl Relay {
    /// 中継と、それを回す Future を返す。呼び出し側が spawn する
    /// （Tauri は tauri::async_runtime::spawn、テストは tokio::spawn）。
    pub fn new(
        socket: PathBuf,
        emit: Emit,
        options: RelayOptions,
    ) -> (Arc<Relay>, impl Future<Output = ()> + Send + 'static) {
        let relay = Arc::new(Relay {
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            writer: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new(
                json!({ "status": "connecting", "detail": null }),
            )),
            options,
        });
        let driver = supervise(relay.clone(), socket, emit);
        (relay, driver)
    }

    /// Rust は method の中身を見ない。params もそのまま渡す。
    pub async fn call(&self, method: String, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (res_tx, res_rx) = oneshot::channel();

        {
            // writer → pending の順でロックを取る。pump 側の切断処理（下）も同じ順で
            // writer を掴んでから pending を drain するので、この insert は
            // 「writer が None になる前」か「後」のどちらか一方に必ず決まる。
            // 前なら fail_all がこの entry を drain して即座に失敗させる、後なら
            // ここで None を見て即座に失敗を返す。どちらにせよ pending に取り
            // 残されることはない。この区間に .await を入れないこと（std::sync::Mutex
            // を async の向こうまで持ち越すと危険）。
            let guard = self.writer.lock().unwrap();
            let tx = match guard.as_ref() {
                Some(tx) => tx.clone(),
                None => return Err("デーモンに接続していません".to_string()),
            };
            self.pending.lock().unwrap().insert(id, res_tx);
            let line = json!({ "id": id, "method": method, "params": params }).to_string();
            if tx.send(line).is_err() {
                self.pending.lock().unwrap().remove(&id);
                return Err("デーモンに接続していません".into());
            }
        }

        match tokio::time::timeout(self.options.request_timeout, res_rx).await {
            Ok(Ok(result)) => result,
            // 切断で pending ごと落とされた
            Ok(Err(_)) => Err("接続が切れました".into()),
            Err(_) => {
                // 外しておかないと、切断まで pending に残り続ける
                self.pending.lock().unwrap().remove(&id);
                Err(format!(
                    "デーモンからの応答がありません（{}ミリ秒待ちました）",
                    self.options.request_timeout.as_millis()
                ))
            }
        }
    }

    /// 今の接続状態。画面が購読を張った直後に1度読んで追いつくために使う。
    pub fn status(&self) -> Value {
        self.status.lock().unwrap().clone()
    }

    /// テスト用。待ち中の要求の数。
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

/// `daemon-connection` の payload。**形の定義はここだけ。**
/// 流す側（emit_status）と、起動直後に問い合わせる側（lib.rs の
/// connection_status）が別々に組み立てると、片方を直したときに
/// もう片方が黙ってずれる。
pub fn connection_payload(status: &str, detail: Option<String>) -> Value {
    json!({ "status": status, "detail": detail })
}

/// 流すと同時に覚える。覚えないと、購読が間に合わなかった画面が永久に追いつけない。
fn emit_status(relay: &Arc<Relay>, emit: &Emit, status: &str, detail: Option<String>) {
    let payload = connection_payload(status, detail);
    *relay.status.lock().unwrap() = payload.clone();
    emit("daemon-connection", payload);
}

fn fail_all(relay: &Arc<Relay>, reason: &str) {
    let waiting: Vec<_> = relay.pending.lock().unwrap().drain().collect();
    for (_, tx) in waiting {
        let _ = tx.send(Err(reason.to_string()));
    }
}

async fn supervise(relay: Arc<Relay>, socket: PathBuf, emit: Emit) {
    let mut backoff = relay.options.backoff_initial;
    let mut announced_connecting = false;
    // 起こした dctld。生きている間は二度と起こさない
    let mut child: Option<std::process::Child> = None;

    loop {
        if !announced_connecting {
            emit_status(&relay, &emit, "connecting", None);
            announced_connecting = true;
        }

        // ソケットファイルが在るのに繋がらないときは消さない。生きているデーモンを
        // 気づかれずに切り離す危険がある（その判定は dctld の assertSocketNotLive の担当）。
        if !socket.exists() && relay.options.spawn_daemon && !still_starting(&mut child) {
            match daemon::spawn_dctld() {
                Ok(c) => {
                    child = Some(c);
                    wait_for_socket(&socket, relay.options.spawn_grace).await;
                }
                Err(e) => emit_status(&relay, &emit, "disconnected", Some(e)),
            }
        }

        match UnixStream::connect(&socket).await {
            Ok(stream) => {
                backoff = relay.options.backoff_initial;
                emit_status(&relay, &emit, "connected", None);
                pump(&relay, stream, &emit).await;
                // pump が writer=None と pending の drain を1つのロックの下で
                // すでに済ませている。ここで二重に drain しても空なので無害だが、
                // 意味が重複するので呼ばない。
                emit_status(&relay, &emit, "disconnected", None);
                announced_connecting = false;
            }
            Err(e) => {
                emit_status(
                    &relay,
                    &emit,
                    "disconnected",
                    Some(format!("{} に接続できません: {e}", socket.display())),
                );
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(relay.options.backoff_max);
    }
}

/// 前に起こした dctld がまだ動いているか。
///
/// **これが無いと同じ DB に2つのデーモンが書く。** dctld が listen するまでに
/// spawn_grace + backoff を超えると、次の周が「ソケットが無い」と見てもう1つ起こす。
/// どちらもまだ listen していないので assertSocketNotLive は両方を通してしまう。
/// 終わっていたら try_wait が刈り取る（ゾンビも残らない）。
fn still_starting(child: &mut Option<std::process::Child>) -> bool {
    let Some(c) = child.as_mut() else {
        return false;
    };
    match c.try_wait() {
        Ok(None) => true, // まだ動いている
        _ => {
            *child = None;
            false
        }
    }
}

async fn wait_for_socket(socket: &PathBuf, grace: Duration) {
    let deadline = tokio::time::Instant::now() + grace;
    while tokio::time::Instant::now() < deadline {
        if socket.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// 1本の接続が生きている間の読み書き。切れたら返る。
async fn pump(relay: &Arc<Relay>, stream: UnixStream, emit: &Emit) {
    let (read_half, mut write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *relay.writer.lock().unwrap() = Some(tx);

    // 書き込みは1本にまとめて直列化する（server.ts が書き込み側でしているのと同じ理由）。
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if write_half.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(read_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        // 壊れた行で接続ごと落とさない。捨てて次へ進む。
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("event").is_some() {
            emit("daemon-event", value);
            continue;
        }
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(sender) = relay.pending.lock().unwrap().remove(&id) else {
            continue;
        };
        let payload = if value.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(value.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("不明なエラーです")
                .to_string())
        };
        let _ = sender.send(payload);
    }

    {
        // writer を None にするのと pending を drain するのを1つのロックの下でやる。
        // 分けると、call がロックを取って Some を見てから insert するまでの間に
        // ここが割り込んで drain してしまい、その insert が誰にも捨てられずに
        // 残る（タイムアウトいっぱい待たされる）レースになる。call 側もこの
        // 同じ writer ロックを insert の前に取るので、両者は必ず順序が決まる。
        let mut guard = relay.writer.lock().unwrap();
        *guard = None;
        fail_all(relay, "接続が切れました");
    }
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `daemon-connection` の実際のワイヤ形。ここが唯一 literal を書いていい場所——
    /// connection_payload の定義そのものを検証する。lib.rs 側はこの関数を
    /// 呼ぶだけなので、二重の形が生まれず、これ以上のクロスチェックは不要。
    #[test]
    fn connection_payload_is_status_and_detail() {
        assert_eq!(
            connection_payload("connecting", None),
            json!({ "status": "connecting", "detail": null })
        );
        assert_eq!(
            connection_payload("disconnected", Some("理由".to_string())),
            json!({ "status": "disconnected", "detail": "理由" })
        );
    }
}
