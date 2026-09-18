mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{collector, until, Fake};
use doctrine_lib::relay::{Relay, RelayOptions};
use serde_json::{json, Value};

fn options() -> RelayOptions {
    RelayOptions {
        request_timeout: Duration::from_millis(500),
        backoff_initial: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        spawn_daemon: false, // テストは実物の dctld を起こさない
        spawn_grace: Duration::from_millis(0),
    }
}

#[tokio::test]
async fn 応答が逆順で返ってきても取り違えない() {
    let mut fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(
        || common::statuses(&seen).contains(&"connected".to_string()),
        "接続",
    )
    .await;

    let a = {
        let r = relay.clone();
        tokio::spawn(async move { r.call("task.list".into(), json!({})).await })
    };
    let b = {
        let r = relay.clone();
        tokio::spawn(async move { r.call("project.list".into(), json!({})).await })
    };

    // 届いた2本の id を拾い、わざと逆順に返す
    let mut ids = Vec::new();
    for _ in 0..2 {
        let line = fake.sent.recv().await.unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        ids.push((
            v["id"].as_u64().unwrap(),
            v["method"].as_str().unwrap().to_string(),
        ));
    }
    for (id, method) in ids.iter().rev() {
        fake.reply
            .send(json!({ "id": id, "ok": true, "result": method }).to_string())
            .unwrap();
    }

    assert_eq!(a.await.unwrap().unwrap(), json!("task.list"));
    assert_eq!(b.await.unwrap().unwrap(), json!("project.list"));
}

#[tokio::test]
async fn イベントは素通しでemitされる() {
    let mut fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(
        || common::statuses(&seen).contains(&"connected".to_string()),
        "接続",
    )
    .await;

    let call = {
        let r = relay.clone();
        tokio::spawn(async move { r.call("task.list".into(), json!({})).await })
    };
    let line = fake.sent.recv().await.unwrap();
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"]
        .as_u64()
        .unwrap();

    // 応答の前にイベントを挟んでも、応答の待ちは壊れない
    fake.reply.send(json!({ "event": "task.stateChanged", "task_id": "t1", "from": "running", "to": "suspended" }).to_string()).unwrap();
    fake.reply
        .send(json!({ "id": id, "ok": true, "result": [] }).to_string())
        .unwrap();

    assert_eq!(call.await.unwrap().unwrap(), json!([]));
    let events: Vec<Value> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == "daemon-event")
        .map(|(_, v)| v.clone())
        .collect();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], json!("task.stateChanged"));
    assert_eq!(events[0]["task_id"], json!("t1"));
}

#[tokio::test]
async fn エラー応答はerrになる() {
    let mut fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(
        || common::statuses(&seen).contains(&"connected".to_string()),
        "接続",
    )
    .await;

    let call = {
        let r = relay.clone();
        tokio::spawn(async move { r.call("task.get".into(), json!({})).await })
    };
    let line = fake.sent.recv().await.unwrap();
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"]
        .as_u64()
        .unwrap();
    fake.reply
        .send(json!({ "id": id, "ok": false, "error": "タスクがありません" }).to_string())
        .unwrap();

    assert_eq!(call.await.unwrap().unwrap_err(), "タスクがありません");
}

#[tokio::test]
async fn 壊れた行を飛ばして次の行を処理する() {
    let mut fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(
        || common::statuses(&seen).contains(&"connected".to_string()),
        "接続",
    )
    .await;

    let call = {
        let r = relay.clone();
        tokio::spawn(async move { r.call("task.list".into(), json!({})).await })
    };
    let line = fake.sent.recv().await.unwrap();
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"]
        .as_u64()
        .unwrap();
    fake.reply.send("{ これは JSON ではない".into()).unwrap();
    fake.reply
        .send(json!({ "id": 99999, "ok": true, "result": "知らない id" }).to_string())
        .unwrap();
    fake.reply
        .send(json!({ "id": id, "ok": true, "result": "本命" }).to_string())
        .unwrap();

    assert_eq!(call.await.unwrap().unwrap(), json!("本命"));
}

#[tokio::test]
async fn 応答が来なければタイムアウトする() {
    let fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(
        || common::statuses(&seen).contains(&"connected".to_string()),
        "接続",
    )
    .await;

    let err = relay.call("task.list".into(), json!({})).await.unwrap_err();
    assert!(err.contains("応答がありません"), "文言が違う: {err}");
    assert_eq!(relay.pending_count(), 0, "タイムアウトした要求が残っている");
}

#[tokio::test]
async fn 接続していないときの呼び出しは即座に失敗する() {
    let dir = tempfile::tempdir().unwrap();
    let (emit, _seen) = collector();
    // 誰も listen していないパス
    let (relay, driver) = Relay::new(dir.path().join("nope.sock"), emit, options());
    tokio::spawn(driver);

    let err = relay.call("task.list".into(), json!({})).await.unwrap_err();
    assert!(err.contains("接続していません"), "文言が違う: {err}");
}

#[tokio::test]
async fn 接続状態は後から問い合わせても分かる() {
    // イベントは購読者が居ない間に流れると消える。画面は起動直後にここを読んで追いつく
    let fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(
        || common::statuses(&seen).contains(&"connected".to_string()),
        "接続",
    )
    .await;

    assert_eq!(relay.status()["status"], json!("connected"));

    fake.stop();
    until(
        || relay.status()["status"] == json!("disconnected"),
        "切断が状態に載る",
    )
    .await;
}

// Arc<Relay> を clone するために使う
fn _assert_send_sync(_: &Arc<Relay>) {}
