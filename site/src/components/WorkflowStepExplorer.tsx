import { useState } from 'react';

type ExampleStep = {
  id: string;
  type: 'agent' | 'command' | 'approval' | 'poll';
  summary: string;
  onFail?: string;
};

// site/src/workflows/minimal.yaml のステップと id・type・順序を揃える
const STEPS: ExampleStep[] = [
  {
    id: 'implement',
    type: 'agent',
    summary: 'タスクの本文を渡して、エージェントに実装とコミットをさせる。',
  },
  {
    id: 'test',
    type: 'command',
    summary: 'シェルコマンドを実行し、終了コードで成否を決める。',
    onFail: '落ちたら出力を添えて implement へ戻る（3 回まで）。',
  },
  {
    id: 'review',
    type: 'approval',
    summary: '人が承認するまで止まる。',
    onFail: '却下されたら理由を添えて implement へ戻る（2 回まで）。',
  },
  {
    id: 'wait-merge',
    type: 'poll',
    summary:
      '5 分ごとにコマンドを実行して PR のマージを待つ。終了コード 0 で済み、75 でまだ、2 で諦める。',
  },
];

export function WorkflowStepExplorer() {
  const [selectedId, setSelectedId] = useState<string>(STEPS[0].id);
  const selected = STEPS.find((step) => step.id === selectedId) ?? STEPS[0];

  return (
    <div className="not-content">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {STEPS.map((step) => {
          const isSelected = step.id === selectedId;
          return (
            <button
              key={step.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setSelectedId(step.id)}
              style={{
                padding: '0.5rem 0.75rem',
                textAlign: 'left',
                cursor: 'pointer',
                color: 'var(--sl-color-text)',
                background: isSelected ? 'var(--sl-color-accent-low)' : 'transparent',
                border: `1px solid ${
                  isSelected ? 'var(--sl-color-accent)' : 'var(--sl-color-gray-5)'
                }`,
                borderRadius: '0.375rem',
              }}
            >
              <div style={{ fontWeight: 600 }}>{step.id}</div>
              <div style={{ fontSize: '0.8em', opacity: 0.8 }}>{step.type}</div>
            </button>
          );
        })}
      </div>
      <div
        style={{
          marginTop: '0.75rem',
          padding: '0.75rem 1rem',
          border: '1px solid var(--sl-color-gray-5)',
          borderRadius: '0.375rem',
          color: 'var(--sl-color-text)',
        }}
      >
        <p style={{ margin: 0 }}>{selected.summary}</p>
        {selected.onFail && <p style={{ margin: '0.5rem 0 0' }}>{selected.onFail}</p>}
      </div>
    </div>
  );
}
