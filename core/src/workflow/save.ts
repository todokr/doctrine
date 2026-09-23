import { join } from "@std/path";
import { isMap, isScalar, isSeq, parseDocument, Scalar, type YAMLMap } from "yaml";
import type { Document } from "yaml";
import type {
  WorkflowBranchChange,
  WorkflowSaveIssue,
  WorkflowStepChange,
} from "../../../shared/protocol.ts";
import { DEFAULT_GUIDE_MAX_ATTEMPTS, parseWorkflow, WorkflowValidationError } from "./schema.ts";
import { writeTextFileAtomic } from "../util/atomicWrite.ts";

/** 文字列 / null / undefined の項目を当てる。undefined は触らず、null はキーを消す。 */
function setOrDelete(map: YAMLMap, key: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null) map.delete(key);
  else map.set(key, value);
}

/**
 * 文字列配列を当てる。値が今と同じなら何もしない。既存の要素ノードを値で使い回し
 * （引用符などの見た目を保つ）、新しい要素は既存の先頭要素と同じ type の Scalar にする。
 * キーが無ければ新しく作る。
 */
// deno-lint-ignore no-explicit-any
function setStringSeq(doc: Document<any>, parent: YAMLMap, key: string, values: string[]): void {
  const existing = parent.get(key, true);
  if (isSeq(existing)) {
    const current = existing.items.map((it) => (isScalar(it) ? it.value : undefined));
    if (current.length === values.length && current.every((v, i) => v === values[i])) return;

    const firstItem = existing.items[0];
    const firstType = isScalar(firstItem) ? (firstItem as Scalar).type : undefined;
    const pool = existing.items.slice();
    existing.items = values.map((v) => {
      const idx = pool.findIndex((it) => isScalar(it) && it.value === v);
      if (idx >= 0) return pool.splice(idx, 1)[0];
      const scalar = new Scalar(v);
      if (firstType) scalar.type = firstType;
      return scalar;
    });
    return;
  }
  parent.set(key, doc.createNode(values));
}

/**
 * 分岐（onFailure / onReject）を当てる。undefined は触らず、null ならキーを消す。
 * guide で分岐が無いとき（既定の分岐）に変更が来たら、既定値を明示的に書いてから当てる。
 */
function applyBranchChange(
  // deno-lint-ignore no-explicit-any
  doc: Document<any>,
  stepMap: YAMLMap,
  stepType: string,
  stepId: string,
  change: WorkflowBranchChange | null | undefined,
): void {
  if (change === undefined) return;
  const key = stepType === "approval" ? "onReject" : "onFailure";
  if (change === null) {
    stepMap.delete(key);
    return;
  }
  let branchNode = stepMap.get(key, true);
  if (!isMap(branchNode)) {
    const defaults = stepType === "guide"
      ? {
        goto: stepId,
        maxAttempts: DEFAULT_GUIDE_MAX_ATTEMPTS,
        feed: `{{ steps.${stepId}.last_stderr }}`,
      }
      : {};
    stepMap.set(key, doc.createNode(defaults));
    branchNode = stepMap.get(key, true);
  }
  const branchMap = branchNode as unknown as YAMLMap;
  if (change.goto !== undefined) branchMap.set("goto", change.goto);
  if (change.maxAttempts !== undefined) branchMap.set("maxAttempts", change.maxAttempts);
  if (change.feed !== undefined) {
    if (change.feed === null) branchMap.delete("feed");
    else branchMap.set("feed", change.feed);
  }
}

function applyStepChange(
  // deno-lint-ignore no-explicit-any
  doc: Document<any>,
  stepMap: YAMLMap,
  stepType: string,
  change: WorkflowStepChange,
): void {
  if (change.prompt !== undefined) stepMap.set("prompt", change.prompt);
  if (change.run !== undefined) stepMap.set("run", change.run);
  setOrDelete(stepMap, "model", change.model);
  setOrDelete(stepMap, "permissionMode", change.permissionMode);
  setOrDelete(stepMap, "session", change.session);

  if (change.allowedTools !== undefined) {
    if (change.allowedTools === null) stepMap.delete("allowedTools");
    else setStringSeq(doc, stepMap, "allowedTools", change.allowedTools);
  }

  if (change.reviewFiles !== undefined) {
    if (change.reviewFiles === null) {
      stepMap.delete("review");
    } else {
      let reviewNode = stepMap.get("review", true);
      if (!isMap(reviewNode)) {
        stepMap.set("review", doc.createNode({}));
        reviewNode = stepMap.get("review", true);
      }
      setStringSeq(doc, reviewNode as unknown as YAMLMap, "files", change.reviewFiles);
    }
  }

  applyBranchChange(doc, stepMap, stepType, change.id, change.branch);
}

/** zod / goto の issue 文字列の中身から field を作る。 */
function normalizeField(rest: string): string {
  if (rest === "onFailure" || rest === "onReject") return "branch";
  if (rest.startsWith("onFailure.") || rest.startsWith("onReject.")) {
    return "branch." + rest.slice(rest.indexOf(".") + 1);
  }
  if (rest === "review" || rest.startsWith("review.")) return "reviewFiles";
  if (rest === "allowedTools" || rest.startsWith("allowedTools.")) return "allowedTools";
  return rest.split(".")[0];
}

/** parseWorkflow が投げる issue 文字列1件を、ステップidと項目名が分かる形に直す。 */
function toSaveIssue(issue: string, stepIds: (string | undefined)[]): WorkflowSaveIssue {
  const gotoMatch = issue.match(/^ステップ "(.+?)" の goto/);
  if (gotoMatch) {
    return { stepId: gotoMatch[1], field: "branch.goto", message: issue };
  }

  const pathMatch = issue.match(/^steps\.(\d+)(?:\.([^:]+))?: (.*)$/);
  if (pathMatch) {
    const index = Number(pathMatch[1]);
    const stepId = stepIds[index] ?? null;
    const rest = pathMatch[2];
    const message = pathMatch[3];
    if (rest === undefined) {
      const unrecognized = message.match(/^認識できないキーがあります: (.+)$/);
      if (unrecognized) {
        const firstKey = unrecognized[1].split(",")[0].trim();
        return { stepId, field: normalizeField(firstKey), message: issue };
      }
      return { stepId, field: null, message: issue };
    }
    return { stepId, field: normalizeField(rest), message: issue };
  }

  return { stepId: null, field: null, message: issue };
}

/**
 * ワークフロー YAML のテキストに変更を当て、コメントと触っていないノードを保ったまま検証する。
 * ファイルには触らない。
 */
export function applyWorkflowChanges(
  yamlText: string,
  changes: WorkflowStepChange[],
): { ok: true; text: string; warnings: string[] } | { ok: false; issues: WorkflowSaveIssue[] } {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: [{
        stepId: null,
        field: null,
        message: `YAMLとして読めません: ${doc.errors.map((e) => e.message).join(", ")}`,
      }],
    };
  }

  const stepsNode = doc.get("steps", true);
  if (!isSeq(stepsNode)) {
    return { ok: false, issues: [{ stepId: null, field: null, message: "steps がありません" }] };
  }

  const issues: WorkflowSaveIssue[] = [];
  const seenIds = new Set<string>();
  for (const change of changes) {
    if (seenIds.has(change.id)) {
      issues.push({
        stepId: change.id,
        field: null,
        message: `同じステップへの変更が2つあります: ${change.id}`,
      });
    }
    seenIds.add(change.id);
  }

  const stepMaps = new Map<string, YAMLMap>();
  const stepIds: (string | undefined)[] = [];
  for (const item of stepsNode.items) {
    if (!isMap(item)) {
      stepIds.push(undefined);
      continue;
    }
    const id = item.get("id");
    if (typeof id === "string") {
      stepMaps.set(id, item);
      stepIds.push(id);
    } else {
      stepIds.push(undefined);
    }
  }

  for (const change of changes) {
    if (!stepMaps.has(change.id)) {
      issues.push({
        stepId: change.id,
        field: null,
        message: `ステップがありません: ${change.id}`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  for (const change of changes) {
    const stepMap = stepMaps.get(change.id)!;
    const stepType = String(stepMap.get("type"));
    applyStepChange(doc, stepMap, stepType, change);
  }

  const text = doc.toString({ lineWidth: 0 });
  try {
    const { warnings } = parseWorkflow(text);
    return { ok: true, text, warnings };
  } catch (e) {
    if (e instanceof WorkflowValidationError) {
      return { ok: false, issues: e.issues.map((i) => toSaveIssue(i, stepIds)) };
    }
    throw e;
  }
}

/** <project>/.doctrine/workflows/<name>.yaml に一時ファイル経由で書く。 */
export async function writeWorkflowYaml(
  projectPath: string,
  name: string,
  text: string,
): Promise<void> {
  await writeTextFileAtomic(join(projectPath, ".doctrine", "workflows", `${name}.yaml`), text);
}
