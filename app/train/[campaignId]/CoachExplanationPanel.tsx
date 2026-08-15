"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { CoachExplanation, HighlightRef } from "@/lib/domain/content";
import { explanationStage, initialExplanationIndex } from "@/lib/domain/timeline";

type Stage = {
  id: "situation" | "judgment" | "result";
  label: "상황" | "판단" | "결과";
};

const STAGES: Stage[] = [
  { id: "situation", label: "상황" },
  { id: "judgment", label: "판단" },
  { id: "result", label: "결과" },
];

type CoachExplanationPanelProps = {
  explanations: CoachExplanation[];
  onSeek: (atMs: number) => void;
  onHighlightsChange: (highlights: HighlightRef[]) => void;
};

export function CoachExplanationPanel({ explanations, onSeek, onHighlightsChange }: CoachExplanationPanelProps) {
  const [activeStage, setActiveStage] = useState<Stage["id"]>("situation");
  const [activeExplanation, setActiveExplanation] = useState(() => initialExplanationIndex(explanations));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const stage = STAGES.find(({ id }) => id === activeStage) ?? STAGES[0];
  const stageExplanations = explanations
    .map((explanation, index) => ({ explanation, index }))
    .filter(({ explanation }) => explanationStage(explanation.kind) === stage.label);

  function select(explanation: CoachExplanation, index: number) {
    setActiveExplanation(index);
    onSeek(explanation.fromMs);
    onHighlightsChange(explanation.highlights);
  }

  function selectStage(nextStage: Stage) {
    setActiveStage(nextStage.id);
    const first = explanations
      .map((explanation, index) => ({ explanation, index }))
      .find(({ explanation }) => explanationStage(explanation.kind) === nextStage.label);
    if (first) select(first.explanation, first.index);
  }

  function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % STAGES.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + STAGES.length) % STAGES.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = STAGES.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectStage(STAGES[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <section className="coach-explanations" aria-label="코치 설명">
      <div className="explanation-tabs" role="tablist" aria-label="설명 단계">
        {STAGES.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => { tabRefs.current[index] = element; }}
            id={`explanation-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={activeStage === item.id}
            aria-controls={`explanation-panel-${item.id}`}
            tabIndex={activeStage === item.id ? 0 : -1}
            onClick={() => selectStage(item)}
            onKeyDown={(event) => moveTabFocus(event, index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id={`explanation-panel-${stage.id}`}
        role="tabpanel"
        aria-labelledby={`explanation-tab-${stage.id}`}
        className="explanation-blocks"
      >
        {stageExplanations.map(({ explanation, index }) => (
          <button
            key={`${explanation.kind}-${explanation.fromMs}-${index}`}
            type="button"
            aria-pressed={activeExplanation === index}
            onClick={() => select(explanation, index)}
          >
            {explanation.text}
          </button>
        ))}
      </div>
    </section>
  );
}
