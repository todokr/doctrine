use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;

/// テスト内に立てる偽の dctld。実物のバイナリは要らない。
pub struct Fake {
    pub path: PathBuf,
    pub dir: tempfile::TempDir,
    /// 中継から届いた行
    pub sent: mpsc::UnboundedReceiver<String>,
    /// 中継へ返す行（改行は自動で付く）
    pub reply: mpsc::UnboundedSender<String>,
    task: tokio::task::JoinHandle<()>,
}

impl Fake {
    pub async fn start() -> Fake {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dctld.sock");
        Fake::listen(dir, path)
    }

    /// 同じパスで立て直す（再接続のテスト用）。
    pub fn restart(dir: tempfile::TempDir, path: PathBuf) -> Fake {
        let _ = std::fs::remove_file(&path);
        Fake::listen(dir, path)
    }

    fn listen(dir: tempfile::TempDir, path: PathBuf) -> Fake {
        let listener = UnixListener::bind(&path).unwrap();
        let (sent_tx, sent_rx) = mpsc::unbounded_channel();
        let (reply_tx, mut reply_rx) = mpsc::unbounded_channel::<String>();
        let task = tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let reader = tokio::spawn(async move {
                while let Ok(Some(l)) = lines.next_line().await {
                    if sent_tx.send(l).is_err() {
                        break;
                    }
                }
            });
            while let Some(line) = reply_rx.recv().await {
                if write
                    .write_all(format!("{line}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            reader.abort();
        });
        Fake {
            path,
            dir,
            sent: sent_rx,
            reply: reply_tx,
            task,
        }
    }

    /// 接続を切る。ディレクトリとパスは呼び出し側が持ち、立て直しに使う。
    pub fn stop(self) -> (tempfile::TempDir, PathBuf) {
        let Fake {
            dir, path, task, ..
        } = self;
        task.abort();
        let _ = std::fs::remove_file(&path);
        (dir, path)
    }
}

pub type Emitted = Arc<Mutex<Vec<(String, Value)>>>;

/// emit を溜める。Tauri を起動せずに中継のイベントを見るため。
pub fn collector() -> (doctrine_lib::relay::Emit, Emitted) {
    let seen: Emitted = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let emit: doctrine_lib::relay::Emit = Arc::new(move |name: &str, payload: Value| {
        sink.lock().unwrap().push((name.to_string(), payload));
    });
    (emit, seen)
}

/// 条件を満たすまで最大 2 秒待つ。
pub async fn until<F: FnMut() -> bool>(mut f: F, what: &str) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("待っても起きませんでした: {what}");
}

pub fn statuses(seen: &Emitted) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == "daemon-connection")
        .filter_map(|(_, v)| v.get("status").and_then(Value::as_str).map(str::to_string))
        .collect()
}
