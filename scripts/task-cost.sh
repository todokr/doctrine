#!/usr/bin/env bash
# タスク1件の、ステップ別コストとエージェントの探索量を出す。
# ワークフローのプロンプトを変えたときに、変更前後のタスクを比べるために使う。
#
#   scripts/task-cost.sh <task-id>
#
# dctld が動いていること、jq があることが前提。
set -euo pipefail

task_id="${1:?usage: scripts/task-cost.sh <task-id>}"

got="$(dctl get "$task_id")"

echo "# $(jq -r '.task.title' <<<"$got")"
echo
echo "## ステップ別（runs は実行回数。bounced は差し戻しで終わった回数）"
jq -r '
  .stepRuns | group_by(.step_id)
  | map({
      step: .[0].step_id,
      first: (map(.id) | min),
      runs: length,
      bounced: (map(select(.status == "bounced")) | length),
      cost: (map(.cost_usd // 0) | add),
      turns: (map(.num_turns // 0) | add)
    })
  | sort_by(.first)
  | (["step", "runs", "bounced", "cost_usd", "turns"] | @tsv),
    (.[] | [.step, .runs, .bounced, (.cost * 100 | round / 100), .turns] | @tsv),
    (["合計", "-", "-", (map(.cost) | add * 100 | round / 100), (map(.turns) | add)] | @tsv)
' <<<"$got" | column -t -s $'\t'

# Claude Code は会話の記録を ~/.claude/projects/<cwd の英数字以外を - にした名前>/ に置く。
# worktree のパスはタスク id を含むので、id で引ける。
echo
echo "## セッション別（first_edit は最初の Edit / Write が何回目のツール呼び出しか。0 は編集なし）"
shopt -s nullglob
found=0
for f in "$HOME"/.claude/projects/*"$task_id"*/*.jsonl; do
  found=1
  head_line="$(jq -rn --arg id "$task_id" '
    first(
      inputs | select(.type == "user") | .message.content
      | if type == "string" then . else (.[0].text // "") end
      | select(. != "") | split("\n")[0] | sub(".*/" + $id + "/"; "") | .[0:40]
    )
  ' "$f")"
  jq -r '
    select(.type == "assistant") | .message.content[]?
    | select(.type == "tool_use") | .name
  ' "$f" | awk -v head="$head_line" '
    { n++; c[$1]++; if (($1 == "Edit" || $1 == "Write") && !first) first = n }
    END {
      printf "%s\n  tool_calls=%d first_edit=%d |", head, n, first
      for (k in c) printf " %s=%d", k, c[k]
      print ""
    }'
done
if [ "$found" = 0 ]; then
  echo "（会話の記録が見つからない: ~/.claude/projects/*$task_id*/）"
fi
