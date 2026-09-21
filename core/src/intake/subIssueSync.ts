import type { IssueRef } from "../../../shared/intake/github.ts";
import { canonicalJson, type Pfd, type Process } from "../../../shared/intake/pfd.ts";
import {
  buildSubIssue,
  parseSubIssueMarker,
  type SubIssueContent,
  upstreamProcessIds,
} from "../../../shared/intake/subIssue.ts";
import { type IntakeRow, listProcesses, updateProcess } from "../db/intakes.ts";
import type { Db } from "../db/schema.ts";
import type { SubIssue, Tracker } from "../github/tracker.ts";
import { sha256Hex } from "./pfd/hash.ts";

export type SubIssueSyncInput = {
  projectPath: string;
  intake: Pick<IntakeRow, "id" | "issue_url" | "issue_node_id">;
  /** 最新の承認の案。承認されていることは呼び出し側が確かめる。 */
  pfd: Pfd;
};

export type SubIssueSyncResult = {
  created: string[]; // process_id
  adopted: string[];
  updated: string[];
  closed: string[];
  failures: {
    processId: string;
    op: "find" | "create" | "update" | "close" | "record";
    message: string;
  }[];
};

type Link = { url: string; nodeId: string; hash: string | null };

type Attempt<T> = { ok: true; value: T } | { ok: false };

/** title と本文の両方を含める。updateIssue は両方を送るので、名前だけの変更も更新の対象になる。 */
function contentHash(content: SubIssueContent): Promise<string> {
  return sha256Hex(canonicalJson(content));
}

/** 上流が先。同順位は pfd.processes の順。閉路があれば残りを pfd.processes の順で後ろに付ける。 */
function topologicalOrder(pfd: Pfd): Process[] {
  const placed = new Set<string>();
  const order: Process[] = [];
  let rest = pfd.processes;
  while (rest.length > 0) {
    const ready = rest.filter((p) => upstreamProcessIds(pfd, p.id).every((id) => placed.has(id)));
    if (ready.length === 0) {
      order.push(...rest);
      break;
    }
    for (const p of ready) {
      order.push(p);
      placed.add(p.id);
    }
    rest = rest.filter((p) => !placed.has(p.id));
  }
  return order;
}

/**
 * 承認済みの案と intake_processes の行から、プロセスごとの sub-issue を作り・採用し・更新し・
 * 取りやめとして閉じる。初回・やり直し・改訂のすべてをこの 1 回の呼び出しで扱う。
 *
 * 行の読み出しに失敗したときだけ投げる。gh の呼び出しと行ごとの書き込みの失敗は
 * failures に入れ、残りのプロセスを続ける。intake_processes の行の追加と retired_at は承認の作業が持つ。
 */
export async function syncSubIssues(
  db: Db,
  tracker: Tracker,
  input: SubIssueSyncInput,
): Promise<SubIssueSyncResult> {
  const { projectPath, intake, pfd } = input;
  const parent: IssueRef = { url: intake.issue_url, nodeId: intake.issue_node_id };
  const result: SubIssueSyncResult = {
    created: [],
    adopted: [],
    updated: [],
    closed: [],
    failures: [],
  };

  const fail = (
    processId: string,
    op: SubIssueSyncResult["failures"][number]["op"],
    e: unknown,
  ) => {
    result.failures.push({ processId, op, message: e instanceof Error ? e.message : String(e) });
  };
  const attempt = async <T>(
    processId: string,
    op: SubIssueSyncResult["failures"][number]["op"],
    f: () => Promise<T>,
  ): Promise<Attempt<T>> => {
    try {
      return { ok: true, value: await f() };
    } catch (e) {
      fail(processId, op, e);
      return { ok: false };
    }
  };

  // 1. 行の突き合わせ
  const rows = await listProcesses(db, intake.id);
  const liveRows = new Map(rows.filter((r) => r.retired_at === null).map((r) => [r.process_id, r]));
  const pfdIds = new Set(pfd.processes.map((p) => p.id));
  for (const p of pfd.processes) {
    if (!liveRows.has(p.id)) {
      fail(p.id, "record", "承認の記録に、このプロセスの生きた行がありません");
    }
  }
  for (const id of liveRows.keys()) {
    if (!pfdIds.has(id)) fail(id, "record", "案に無いプロセスの行が取りやめになっていません");
  }
  const targets = topologicalOrder(pfd).filter((p) => liveRows.has(p.id));

  // DB に記録済みの紐づけ
  const links = new Map<string, Link>();
  // 本文に入れる URL。作ったが記録に失敗したものも含む
  const urls = new Map<string, string>();
  for (const r of liveRows.values()) {
    if (r.sub_issue_url === null) continue;
    links.set(r.process_id, {
      url: r.sub_issue_url,
      nodeId: r.sub_issue_node_id!,
      hash: r.sub_issue_hash,
    });
    urls.set(r.process_id, r.sub_issue_url);
  }

  const content = (p: Process): SubIssueContent =>
    buildSubIssue({ pfd, intakeId: intake.id, processId: p.id, upstreamUrls: urls });

  // 2. 取りやめ
  for (const r of rows) {
    if (r.retired_at === null || r.sub_issue_url === null || r.sub_issue_closed !== 0) continue;
    const ref: IssueRef = { url: r.sub_issue_url, nodeId: r.sub_issue_node_id! };
    const closed = await attempt(
      r.process_id,
      "close",
      async () => {
        await tracker.closeIssue(projectPath, ref, "not_planned");
        await updateProcess(db, intake.id, r.process_id, { sub_issue_closed: 1 });
      },
    );
    if (closed.ok) result.closed.push(r.process_id);
  }

  // 3. 採用。探せないまま作ると重複するので、探せなかった回は作らない
  const unlinked = targets.filter((p) => !links.has(p.id));
  let canCreate = true;
  // 見つかったが記録に失敗したもの。作ると重複する
  const found = new Set<string>();
  if (unlinked.length > 0) {
    let listed: SubIssue[] = [];
    try {
      listed = await tracker.findSubIssues(projectPath, parent);
    } catch (e) {
      canCreate = false;
      for (const p of unlinked) fail(p.id, "find", e);
    }
    if (canCreate) {
      const wanted = new Set(unlinked.map((p) => p.id));
      for (const sub of listed) {
        const marker = parseSubIssueMarker(sub.body);
        if (!marker || marker.intakeId !== intake.id || !wanted.has(marker.processId)) continue;
        if (found.has(marker.processId)) continue;
        found.add(marker.processId);
        // 閉じられた sub-issue も採用する。状態は見ない
        const recorded = await attempt(
          marker.processId,
          "record",
          () =>
            updateProcess(db, intake.id, marker.processId, {
              sub_issue_url: sub.ref.url,
              sub_issue_node_id: sub.ref.nodeId,
              sub_issue_hash: null,
            }),
        );
        if (!recorded.ok) continue;
        links.set(marker.processId, { url: sub.ref.url, nodeId: sub.ref.nodeId, hash: null });
        urls.set(marker.processId, sub.ref.url);
        result.adopted.push(marker.processId);
      }
    }
  }

  // 4. 作成。上流から順に作るので、下流の本文に上流の URL が初回から入る
  const createdNow = new Set<string>();
  if (canCreate) {
    for (const p of targets) {
      if (links.has(p.id) || found.has(p.id)) continue;
      const body = content(p);
      const made = await attempt(
        p.id,
        "create",
        () => tracker.createSubIssue(projectPath, parent, body),
      );
      if (!made.ok) continue;
      const ref = made.value;
      createdNow.add(p.id);
      urls.set(p.id, ref.url);
      // 記録に失敗しても、次の回が目印で見つけて採用する
      const hash = await contentHash(body);
      const recorded = await attempt(p.id, "record", () =>
        updateProcess(db, intake.id, p.id, {
          sub_issue_url: ref.url,
          sub_issue_node_id: ref.nodeId,
          sub_issue_hash: hash,
        }));
      if (!recorded.ok) continue;
      links.set(p.id, { url: ref.url, nodeId: ref.nodeId, hash });
      result.created.push(p.id);
    }
  }

  // 5. 更新。作ったばかりのものは今の本文で作ってあるので飛ばす
  for (const p of targets) {
    const link = links.get(p.id);
    if (!link || createdNow.has(p.id)) continue;
    const body = content(p);
    const hash = await contentHash(body);
    if (hash === link.hash) continue;
    const updated = await attempt(p.id, "update", async () => {
      await tracker.updateIssue(projectPath, { url: link.url, nodeId: link.nodeId }, body);
      await updateProcess(db, intake.id, p.id, { sub_issue_hash: hash });
    });
    if (updated.ok) {
      links.set(p.id, { ...link, hash });
      result.updated.push(p.id);
    }
  }

  return result;
}
