mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::{collector, until, Fake};
use doctrine_lib::relay::{Relay, RelayOptions, Spawner};
use serde_json::{json, Value};

fn options() -> RelayOptions {
    RelayOptions {
        request_timeout: Duration::from_millis(500),
        backoff_initial: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        spawn: None, // テストは実物の dctld を起こさない
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
        let line = fake.recv_sent("逆順に返す2本目の要求").await;
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
    let line = fake.recv_sent("relay からの要求").await;
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
    let line = fake.recv_sent("relay からの要求").await;
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
    let line = fake.recv_sent("relay からの要求").await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn 切断で待ち中の要求が失敗し_立て直すと復帰する() {
    let fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    let driver = tokio::spawn(driver);
    until(
        || common::statuses(&seen).contains(&"connected".to_string()),
        "最初の接続",
    )
    .await;

    // 応答を返さないまま落とす
    let waiting = {
        let r = relay.clone();
        tokio::spawn(async move { r.call("task.list".into(), json!({})).await })
    };
    until(|| relay.pending_count() == 1, "要求が届く").await;
    let (dir, path) = fake.stop();

    assert_eq!(waiting.await.unwrap().unwrap_err(), "接続が切れました");
    until(
        || common::statuses(&seen).contains(&"disconnected".to_string()),
        "切断の通知",
    )
    .await;
    assert_eq!(relay.pending_count(), 0, "切断後も要求が残っている");

    // 立て直すと自動で復帰する
    let mut fake = Fake::restart(dir, path);
    until(
        || {
            common::statuses(&seen)
                .iter()
                .filter(|s| *s == "connected")
                .count()
                == 2
        },
        "再接続",
    )
    .await;

    let call = {
        let r = relay.clone();
        tokio::spawn(async move { r.call("task.list".into(), json!({})).await })
    };
    let line = fake.recv_sent("relay からの要求").await;
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"]
        .as_u64()
        .unwrap();
    fake.reply
        .send(json!({ "id": id, "ok": true, "result": "復帰" }).to_string())
        .unwrap();
    assert_eq!(call.await.unwrap().unwrap(), json!("復帰"));

    driver.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn 最初からデーモンが居なくても_後から立てれば繋がる() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dctld.sock");
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(path.clone(), emit, options());
    let driver = tokio::spawn(driver);

    until(
        || common::statuses(&seen).contains(&"disconnected".to_string()),
        "繋がらない通知",
    )
    .await;
    assert!(relay.call("task.list".into(), json!({})).await.is_err());

    let mut fake = Fake::restart(dir, path);
    until(
        || common::statuses(&seen).contains(&"connected".to_string()),
        "後から接続",
    )
    .await;

    let call = {
        let r = relay.clone();
        tokio::spawn(async move { r.call("task.list".into(), json!({})).await })
    };
    let line = fake.recv_sent("relay からの要求").await;
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"]
        .as_u64()
        .unwrap();
    fake.reply
        .send(json!({ "id": id, "ok": true, "result": [] }).to_string())
        .unwrap();
    assert_eq!(call.await.unwrap().unwrap(), json!([]));

    driver.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spawn_失敗の理由は接続失敗の文言で上書きされない() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nope").join("dctld.sock"); // 親ディレクトリも無い＝ENOENT
    let (emit, seen) = collector();
    let spawn: Spawner =
        Arc::new(|| Err("dctld が見つかりません（deno task install で入ります）".into()));
    let mut opts = options();
    opts.spawn = Some(spawn);
    let (_relay, driver) = Relay::new(path, emit, opts);
    tokio::spawn(driver);

    // 何周かバックオフを跨いで disconnected を複数回観測する
    until(
        || common::statuses_with_detail(&seen).len() >= 3,
        "複数回の disconnected",
    )
    .await;

    let details = common::statuses_with_detail(&seen);
    assert!(
        details.iter().all(|d| d.contains("dctld が見つかりません")),
        "spawn 失敗の detail が上書きされている: {details:?}"
    );
    assert!(
        details.iter().all(|d| !d.contains("接続できません")),
        "spawn 失敗の直後に接続失敗の文言が出ている: {details:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn 生きていないソケットファイルが在っても_spawn_が呼ばれ_ファイルは消さない() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dctld.sock");
    // 「ファイルはあるが誰も listen していない」状態を作る。bind してすぐ drop すると
    // ファイルは残るが、listen していたソケットは無くなる（Fake::stop がしているのと同じ）。
    {
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        drop(listener);
    }
    assert!(path.exists(), "テストの前提: ファイルは残っているはず");

    // この環境で本当に ECONNREFUSED になることを、想定に頼らず確かめる
    let err = tokio::net::UnixStream::connect(&path).await.unwrap_err();
    assert_eq!(
        err.kind(),
        std::io::ErrorKind::ConnectionRefused,
        "この環境では stale なソケットが違う種類のエラーになる: {err:?}"
    );

    let calls = Arc::new(AtomicUsize::new(0));
    let calls2 = calls.clone();
    let spawn: Spawner = Arc::new(move || {
        calls2.fetch_add(1, Ordering::SeqCst);
        Err("テスト用のダミー spawn".into())
    });
    let (emit, _seen) = collector();
    let mut opts = options();
    opts.spawn = Some(spawn);
    let (_relay, driver) = Relay::new(path.clone(), emit, opts);
    tokio::spawn(driver);

    until(
        || calls.load(Ordering::SeqCst) >= 1,
        "stale ソケットでも spawn が呼ばれる",
    )
    .await;
    assert!(path.exists(), "中継がソケットファイルを消してしまった");
}

const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Relay>();
};
