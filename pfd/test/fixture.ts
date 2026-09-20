/** spec 6.1 の例を、検証（spec 6.2）に通る形で埋めたもの。 */
export const EXAMPLE_YAML = `issue: 123
title: 利用状況の集計を画面に出す
goal: [feature]

artifacts:
  - id: schema
    name: 既存スキーマ
    given: true
  - id: new-table
    name: 集計テーブル
    description: 日次の利用回数を持つテーブルとマイグレーション
    verify: マイグレーションが適用でき、テーブル定義のテストが通る
  - id: metric-definition
    name: 集計の定義
    description: 何を 1 回の利用と数えるか
    verify: 決めた内容が pfd done の note に書かれている
  - id: endpoint
    name: 集計 API
    description: 日次の利用回数を返す GET /usage
    verify: API のテストが通る
  - id: feature
    name: 集計画面
    description: 利用回数のグラフを出す画面
    verify: 画面のテストが通る

processes:
  - id: 1
    name: マイグレーションを書く
    inputs: [schema]
    outputs: [new-table]
    purpose: 集計結果を置く場所を用意する
    steps: 日次の利用回数を持つテーブルのマイグレーションを足す
    done_when: マイグレーションが適用でき、テストが通る
  - id: 2
    name: API を実装する
    inputs: [new-table, metric-definition]
    outputs: [endpoint]
    purpose: 集計テーブルの数字を外から読めるようにする
    steps: GET /usage を足し、集計テーブルを読んで返す
    done_when: API のテストが通る
  - id: 3
    name: 集計の定義を決める
    actor: human
    inputs: [schema]
    outputs: [metric-definition]
    purpose: 何を 1 回の利用と数えるかを決める
    done_when: 定義が文章になっている
  - id: 4
    name: 画面を繋ぐ
    inputs: [endpoint]
    outputs: [feature]
    purpose: 利用者が集計を見られるようにする
    steps: GET /usage を呼び、グラフを描く画面を足す
    done_when: 画面のテストが通る
`;
