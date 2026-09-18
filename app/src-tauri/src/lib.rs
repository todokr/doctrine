// ガワだけの段階。デーモンへの中継（invoke("rpc") / emit("daemon-event")）、トレイ、
// single-instance はまだ持たない（docs/superpowers/specs/2026-09-13-review-app-design.md 4・8章）
pub mod daemon;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
