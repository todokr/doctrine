import type { Answer, Question } from "../../../shared/intake/question.ts";
import { answerIssues, normalizeAnswers, toggleOption, updateAnswer } from "../intake";
import { MaterialView } from "./MaterialView";
import { Markdown } from "./text";

export type QuestionFormProps =
  | { questions: Question[]; answers: Answer[]; readOnly: true }
  | {
      questions: Question[];
      answers: Answer[];
      readOnly?: false;
      /** 入力のたびに、生の回答（空文字を含む）を返す。呼び出し側が下書きに持つ */
      onChange: (answers: Answer[]) => void;
      /** 「回答を送る…」で、normalizeAnswers を通した回答を返す。answerIssues が空のときだけ押せる */
      onSubmit: (answers: Answer[]) => void;
    };

const KIND_LABEL: Record<Question["kind"], string> = {
  single: "単一選択",
  multiple: "複数選択",
  free: "自由記述",
};

export function QuestionForm(p: QuestionFormProps) {
  const { questions, answers } = p;
  const issues = p.readOnly ? [] : answerIssues(questions, answers);
  return (
    <>
      {questions.map((question, i) => (
        <QuestionCard
          key={question.id}
          index={i}
          question={question}
          answer={answers.find((a) => a.questionId === question.id)}
          issue={issues.find((x) => x.questionId === question.id)?.message ?? null}
          readOnly={!!p.readOnly}
          onChange={(patch) => {
            if (!p.readOnly) p.onChange(updateAnswer(answers, question.id, patch));
          }}
        />
      ))}
      {!p.readOnly && (
        <div className="decide">
          <span className="meta">未回答 {issues.length} 件</span>
          <button
            className="btn primary"
            disabled={issues.length > 0}
            onClick={() => p.onSubmit(normalizeAnswers(questions, answers))}
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
  const recommended = question.recommendation?.optionIds ?? [];
  const reason = question.recommendation?.reason ?? "";
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
                  {recommended.includes(option.id) && <span className="rec">推奨</span>}
                  {readOnly && chosen && <span className="rec">選んだ</span>}
                </span>
                <span className="ds">{option.description}</span>
                {recommended.includes(option.id) && <span className="ds recwhy">{reason}</span>}
              </label>
            );
          })}
        </div>
      )}
      {question.kind === "free" && question.recommendation?.text != null && (
        <div className="opts">
          <div className="opt rec-row">
            <span className="lb">
              {question.recommendation.text}
              <span className="rec">推奨</span>
            </span>
            <span className="ds recwhy">{reason}</span>
          </div>
        </div>
      )}
      <div className="qextra">
        <Extra label={otherLabel} value={answer?.other ?? null} readOnly={readOnly} onChange={(other) => p.onChange({ other })} />
        <Extra label="補足" value={answer?.note ?? null} readOnly={readOnly} onChange={(note) => p.onChange({ note })} />
      </div>
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
