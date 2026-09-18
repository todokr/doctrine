mod common;

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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn 接続していないときの呼び出しは即座に失敗する() {
    let dir = tempfile::tempdir().unwrap();
    let (emit, _seen) = collector();
    // 誰も listen していないパス
    let (relay, driver) = Relay::new(dir.path().join("nope.sock"), emit, options());
    tokio::spawn(driver);

    let err = relay.call("task.list".into(), json!({})).await.unwrap_err();
    assert!(err.contains("接続していません"), "文言が違う: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn 切断と同時に投げた要求が_pending_に取り残されない() {
    // 取り残されると、呼び出し側は「接続が切れました」で即座に失敗する代わりに
    // タイムアウト（本番で 30 秒）いっぱい待たされる。current_thread ランタイムでは
    // call の中の「writer を見る」と「pending に insert する」の間に pump の切断処理が
    // 割り込めないので、このレースは multi_thread でしか再現しない。
    //
    // 1 ラウンドだけだと、レースの窓は数命令ぶんしかなく、OS スケジューラが
    // ちょうどそこに割り込む確率は極めて低い（実測: 単発 1 セット・64 並列の
    // 呼び出しでは buggy 版に対しても 40 回試して 1 回も落とせなかった）。
    // fake を繰り返し立て直して「同時に呼ぶ→切る→直後に見る」を何百回も回す
    // ことで、狂ったタイミングでのスケジュールを実際に踏ませる。
    // （診断: buggy 版に対して 300 ラウンドなら 20/20 回検出、150 ラウンドでは
    //  19/20 回、50 ラウンドでは 7/20 回だった。300 ラウンドを採用する。）
    let mut fake = Fake::start().await;
    for round in 0..300 {
        let (emit, seen) = collector();
        let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
        tokio::spawn(driver);
        until(
            || common::statuses(&seen).contains(&"connected".to_string()),
            "接続",
        )
        .await;

        // 応答は誰も返さない。呼び出しの最中に fake を落として、
        // 「writer を見る」と「pending に insert する」の間に切断処理が
        // 挟まる余地を作る。
        let calls: Vec<_> = (0..32)
            .map(|_| {
                let r = relay.clone();
                tokio::spawn(async move { r.call("task.list".into(), json!({})).await })
            })
            .collect();

        let (dir, path) = fake.stop();

        until(
            || relay.status()["status"] == json!("disconnected"),
            "切断が状態に載る",
        )
        .await;

        // ここが肝心：disconnected を観測した直後に見る。呼び出しの完了を待って
        // から見ると、レースに乗ってしまった要求もその後 500ms のタイムアウトで
        // 自然に pending から消えてしまい、バグを覆い隠してしまう
        // （実際にこれで一度、レースを再現できないテストを書いてしまった）。
        // disconnected の直後はまだタイムアウトが来ていないはずの時間なので、
        // ここで残っていたらそれは drain を取りこぼした証拠。
        let pending = relay.pending_count();
        assert_eq!(
            pending, 0,
            "ラウンド {round}: 切断直後なのに pending に要求が {pending} 件残っている\
             （drain を取りこぼした = タイムアウトいっぱい待たされる）"
        );

        for c in calls {
            let _ = c.await;
        }
        fake = Fake::restart(dir, path);
    }
}

const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Relay>();
};
