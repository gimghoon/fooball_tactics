export type TrainingStage = "fixo" | "ala" | "pivo" | "recap";

export function advanceRole(stage: Exclude<TrainingStage, "recap">): TrainingStage {
  return { fixo: "ala", ala: "pivo", pivo: "recap" }[stage] as TrainingStage;
}

export function evaluateAttempt(correct: boolean, misses: number) {
  if (correct) return { misses, feedback: "correct" as const };

  const nextMisses = misses + 1;
  return {
    misses: nextMisses,
    feedback: nextMisses === 1 ? ("hint" as const) : ("answer" as const),
  };
}

