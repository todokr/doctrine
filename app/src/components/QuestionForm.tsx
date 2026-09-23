import type { Answer, Assumption, AssumptionResponse, Question } from "../../../shared/intake/question.ts";
import type { QuestionSetContent, QuestionSetReply } from "../../../shared/intake/validateQuestion.ts";
import { answerIssues, normalizeReply, toggleOption, updateAnswer, updateResponse } from "../intake";
import { EvidenceView } from "./EvidenceView";
import { MaterialView } from "./MaterialView";
import { Markdown } from "./text";

export type QuestionFormProps =
  | { set: QuestionSetContent; reply: QuestionSetReply; readOnly: true }
  | {
      set: QuestionSetContent;
      reply: QuestionSetReply;
      readOnly?: false;
      /** 入力のたびに、生の回答と応答（空文字を含む）を返す。呼び出し側が下書きに持つ */
      onChange: (reply: QuestionSetReply) => void;
      /** 「回答を送る…」で、normalizeReply を通した回答と応答を返す。answerIssues が空のときだけ押せる */
      onSubmit: (reply: QuestionSetReply) => void;
    };

const KIND_LABEL: Record<Question["kind"], string> = {
  single: "単一選択",
  multiple: "複数選択",
  free: "自由記述",
};

export function QuestionForm(p: QuestionFormProps) {
  const { set, reply } = p;
  const issues = p.readOnly ? [] : answerIssues(set, reply);
  const issueOf = (id: string) => issues.find((x) => x.targetId === id)?.message ?? null;
  return (
    <>
      {set.questions.map((question, i) => (
        <QuestionCard
          key={question.id}
          index={i}
          question={question}
          answer={reply.answers.find((a) => a.questionId === question.id)}
          issue={issueOf(question.id)}
          readOnly={!!p.readOnly}
          onChange={(patch) => {
            if (!p.readOnly) p.onChange({ ...reply, answers: updateAnswer(reply.answers, question.id, patch) });
          }}
        />
      ))}
      {set.assumptions.length > 0 && <h2 className="qsection">エージェントの仮定</h2>}
      {set.assumptions.map((assumption, i) => (
        <AssumptionCard
          key={assumption.id}
          index={i}
          assumption={assumption}
          response={reply.assumptionResponses.find((r) => r.assumptionId === assumption.id)}
          issue={issueOf(assumption.id)}
          readOnly={!!p.readOnly}
          onChange={(next) => {
            if (!p.readOnly) {
              p.onChange({ ...reply, assumptionResponses: updateResponse(reply.assumptionResponses, next) });
            }
          }}
        />
      ))}
      {!p.readOnly && (
        <div className="decide">
          <span className="meta">未回答 {issues.length} 件</span>
          <button
            className="btn primary"
            disabled={issues.length > 0}
            onClick={() => p.onSubmit(normalizeReply(set, reply))}
          >
            回答を送る…
          </button>
        </div>
      )}
    </>
  );
}

function QuestionCard(p: {
  index: number;
  question: Question;
  answer: Answer | undefined;
  issue: string | null;
  readOnly: boolean;
  onChange: (patch: Partial<Omit<Answer, "questionId">>) => void;
}) {
  const { question, answer, readOnly } = p;
  const otherLabel = question.kind === "free" ? "答え" : "その他（選択肢以外の答え）";

  return (
    <section className={p.issue ? "qcard missing" : "qcard"}>
      <div className="qhead">
        <span className="qno">Q{p.index + 1}</span>
        <h2>{question.prompt}</h2>
        <span className="qkind">{KIND_LABEL[question.kind]}</span>
      </div>
      {question.materials.map((m, i) => <MaterialView key={i} material={m} />)}
      {question.kind !== "free" && (
        <div className="opts">
          {question.options.map((option) => {
            const chosen = answer?.optionIds.includes(option.id) ?? false;
            const cls = ["opt", chosen && "on", readOnly && "readonly"].filter(Boolean).join(" ");
            return (
              <label key={option.id} className={cls}>
                {!readOnly && (
                  <input
                    type={question.kind === "single" ? "radio" : "checkbox"}
                    name={question.id}
                    checked={chosen}
                    onChange={() => p.onChange({ optionIds: toggleOption(question, answer?.optionIds ?? [], option.id) })}
                  />
                )}
                <span className="lb">
                  {option.label}
                  {readOnly && chosen && <span className="rec">選んだ</span>}
                </span>
                <span className="ds">{option.description}</span>
              </label>
            );
          })}
        </div>
      )}
      <div className="qextra">
        <Extra label={otherLabel} value={answer?.other ?? null} readOnly={readOnly} onChange={(other) => p.onChange({ other })} />
        <Extra label="補足・選んだ理由" value={answer?.note ?? null} readOnly={readOnly} onChange={(note) => p.onChange({ note })} />
      </div>
      {p.issue && <p className="qmissing">{p.issue}</p>}
    </section>
  );
}

function AssumptionCard(p: {
  index: number;
  assumption: Assumption;
  response: AssumptionResponse | undefined;
  issue: string | null;
  readOnly: boolean;
  onChange: (next: AssumptionResponse) => void;
}) {
  const { assumption, response, readOnly } = p;
  const id = assumption.id;
  const correction = response?.verdict === "corrected" ? response.correction : "";
  const verdicts: { verdict: AssumptionResponse["verdict"]; label: string }[] = [
    { verdict: "accepted", label: "認める" },
    { verdict: "corrected", label: "書き直す" },
  ];

  return (
    <section className={p.issue ? "qcard missing" : "qcard"}>
      <div className="qhead">
        <span className="qno">仮定{p.index + 1}</span>
        <h2>{assumption.statement}</h2>
      </div>
      {assumption.evidence.map((e, i) => <EvidenceView key={i} evidence={e} />)}
      <div className="ro impact">
        崩れたときに変わるところ
        <div className="g-md"><Markdown src={assumption.impact} /></div>
      </div>
      <div className="opts">
        {verdicts.map(({ verdict, label }) => {
          const chosen = response?.verdict === verdict;
          if (readOnly && !chosen) return null;
          const cls = ["opt", chosen && "on", readOnly && "readonly"].filter(Boolean).join(" ");
          return (
            <label key={verdict} className={cls}>
              {!readOnly && (
                <input
                  type="radio"
                  name={`assumption-${id}`}
                  checked={chosen}
                  onChange={() =>
                    p.onChange(
                      verdict === "accepted"
                        ? { assumptionId: id, verdict }
                        : { assumptionId: id, verdict, correction },
                    )}
                />
              )}
              <span className="lb">{label}</span>
            </label>
          );
        })}
      </div>
      {response?.verdict === "corrected" && (
        <div className="qextra single">
          <Extra
            label="正しい内容"
            value={correction}
            readOnly={readOnly}
            onChange={(text) => p.onChange({ assumptionId: id, verdict: "corrected", correction: text })}
          />
        </div>
      )}
      {p.issue && <p className="qmissing">{p.issue}</p>}
    </section>
  );
}

function Extra(p: { label: string; value: string | null; readOnly: boolean; onChange: (value: string) => void }) {
  if (p.readOnly) {
    if (p.value === null || p.value.trim() === "") return null;
    return (
      <div className="ro">
        {p.label}
        <div className="g-md"><Markdown src={p.value} /></div>
      </div>
    );
  }
  return (
    <label>
      {p.label}
      <textarea value={p.value ?? ""} onChange={(e) => p.onChange(e.target.value)} />
    </label>
  );
}
