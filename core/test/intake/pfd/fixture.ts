import type { Pfd } from "../../../../shared/intake/pfd.ts";
import type { ValidateContext } from "../../../src/intake/pfd/validate.ts";

/** PFD spec 6.1 の例を、検証に通る形で埋めたもの。呼ぶたびに新しいオブジェクトを返す。 */
export function example(): Pfd {
  return {
    title: "利用状況の集計を画面に出す",
    goal: ["feature"],
    artifacts: [
      { id: "schema", name: "既存スキーマ", given: true },
      {
        id: "new-table",
        name: "集計テーブル",
        given: false,
        description: "日次の利用回数を持つテーブルとマイグレーション",
        verify: "マイグレーションが適用でき、テーブル定義のテストが通る",
      },
      {
        id: "metric-definition",
        name: "集計の定義",
        given: false,
        description: "何を 1 回の利用と数えるか",
        verify: "決めた内容が完了の記録の note に書かれている",
      },
      {
        id: "endpoint",
        name: "集計 API",
        given: false,
        description: "日次の利用回数を返す GET /usage",
        verify: "API のテストが通る",
      },
      {
        id: "feature",
        name: "集計画面",
        given: false,
        description: "利用回数のグラフを出す画面",
        verify: "画面のテストが通る",
      },
    ],
    processes: [
      {
        id: "1",
        name: "マイグレーションを書く",
        actor: "agent",
        inputs: ["schema"],
        outputs: ["new-table"],
        purpose: "集計結果を置く場所を用意する",
        steps: "日次の利用回数を持つテーブルのマイグレーションを足す",
        done_when: "マイグレーションが適用でき、テストが通る",
      },
      {
        id: "2",
        name: "API を実装する",
        actor: "agent",
        inputs: ["new-table", "metric-definition"],
        outputs: ["endpoint"],
        purpose: "集計テーブルの数字を外から読めるようにする",
        steps: "GET /usage を足し、集計テーブルを読んで返す",
        done_when: "API のテストが通る",
      },
      {
        id: "3",
        name: "集計の定義を決める",
        actor: "human",
        inputs: ["schema"],
        outputs: ["metric-definition"],
        purpose: "何を 1 回の利用と数えるかを決める",
        done_when: "定義が文章になっている",
      },
      {
        id: "4",
        name: "画面を繋ぐ",
        actor: "agent",
        inputs: ["endpoint"],
        outputs: ["feature"],
        purpose: "利用者が集計を見られるようにする",
        steps: "GET /usage を呼び、グラフを描く画面を足す",
        done_when: "画面のテストが通る",
      },
    ],
  };
}

/** example() からプロセス 4 を除き、画面を 2 つに分けた 4b を足したもの（検証に通る）。 */
export function revised(): Pfd {
  const pfd = example();
  pfd.processes = pfd.processes.filter((p) => p.id !== "4");
  pfd.processes.push({
    id: "4b",
    name: "画面を 2 つに分けて繋ぐ",
    actor: "agent",
    inputs: ["endpoint"],
    outputs: ["feature"],
    purpose: "利用者が集計を見られるようにする",
    steps: "GET /usage を呼び、グラフと表の 2 つの画面を足す",
    done_when: "画面のテストが通る",
  });
  return pfd;
}

export const noContext: ValidateContext = { answeredQuestionIds: new Set(), frozen: null };

/** example() に、質問 q1 の回答を指す成果物 policy を足し、プロセス 2 の入力に加えたもの。 */
export function withDecision(): Pfd {
  const pfd = example();
  pfd.artifacts.push({ id: "policy", name: "集計の方針", given: true, decision: "q1" });
  pfd.processes[1].inputs = ["new-table", "metric-definition", "policy"];
  return pfd;
}
