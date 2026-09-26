import type { ParamsOf, StepView, WorkflowListEntry } from "../../shared/protocol.ts";
import type { ComposerInit } from "./model";
import type { Project } from "./types";

/** 入力中の値。project は Project.path、workflow は WorkflowListEntry.name（未選択は ""） */
export type ComposerForm = { project: string; workflow: string; title: string; prompt: string };

/** 「＋」は絞り込み中のプロジェクトへ倒す。filter は State.project（"all" か表示名） */
export function initialComposerForm(projects: Project[], init: ComposerInit, filter: string): ComposerForm {
  const project = projects.find((p) => p.path === init.project)?.path
    ?? projects.find((p) => p.id === filter)?.path
    ?? projects[0]?.path
    ?? "";
  return { project, workflow: init.workflow ?? "", title: init.title ?? "", prompt: init.prompt ?? "" };
}

/** preferred が選べればそれ。でなければ既定、それも選べなければ最初の選べるもの */
export function pickWorkflow(entries: WorkflowListEntry[], preferred: string): string {
  const ok = entries.filter((e) => e.ok);
  return (ok.find((e) => e.name === preferred) ?? ok.find((e) => e.default) ?? ok[0])?.name ?? "";
}

export type ComposerWorkflowOption = { name: string; label: string; disabled: boolean };

export function composerWorkflowOptions(entries: WorkflowListEntry[]): ComposerWorkflowOption[] {
  return entries.map((e) => ({
    name: e.name,
    label: !e.ok ? `${e.name}（不正）` : e.default ? `${e.name}（既定）` : e.name,
    disabled: !e.ok,
  }));
}

export function selectedSteps(entries: WorkflowListEntry[], name: string): StepView[] | null {
  const e = entries.find((x) => x.name === name);
  return e?.ok ? e.steps : null;
}

export function canSubmitComposer(form: ComposerForm, entries: WorkflowListEntry[]): boolean {
  return form.project !== "" &&
    selectedSteps(entries, form.workflow) !== null &&
    form.title.trim() !== "" &&
    form.prompt.trim() !== "";
}

/** priority は渡さない（デーモンが既定の 2 にする） */
export function createParams(form: ComposerForm): ParamsOf<"task.create"> {
  return { project: form.project, workflow: form.workflow, title: form.title.trim(), prompt: form.prompt };
}

export function createdToast(title: string, warnings: string[]): string {
  const head = `タスクを作りました: ${title}`;
  return warnings.length ? `${head}（警告: ${warnings.join(" / ")}）` : head;
}
