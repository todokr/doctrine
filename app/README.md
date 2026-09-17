# doctrine レビューアプリ（ガワ）

[レビューアプリ設計](../docs/superpowers/specs/2026-09-13-review-app-design.md) の画面を、Tauri v2 + React + Vite で組んだもの。
中身は [`prototype/review-app-mvp.html`](../prototype/review-app-mvp.html) のモックデータで、**デーモンにはつながっていない。**

```bash
mise install          # Rust（リポジトリ直下の mise.toml）
pnpm install
pnpm tauri dev        # ウィンドウで開く
pnpm dev              # ブラウザで開く（http://localhost:1420）
pnpm test             # 状態の更新と導出（src/model.ts）の単体テスト
```

Linux では WebKitGTK 4.1 などが要る（[Tauri の前提](https://tauri.app/start/prerequisites/)）。

## 構成

- `src/model.ts` — 画面の状態と reducer、サイドバーの区分・差し戻しコメントの組み立てなどの純関数
- `src/mock.ts` — モックデータ。デーモンにつないだら `task.list` / `task.diff` / `task.context` に置き換える
- `src/store.tsx` — reducer の置き場所と、下書きの保存（当面 localStorage）
- `src/components/` — 画面
- `src-tauri/` — Tauri の最小構成

## まだ無いもの

- Rust からデーモンへの中継（`invoke("rpc")` / `emit("daemon-event")`）と `dctld` の起動
- トレイ、single-instance、通知
- `src/daemon/protocol.ts` の型の共有
