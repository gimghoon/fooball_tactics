export type Principle = "width" | "support" | "pivot" | "transition";
export type Attempt = {
  principle: Principle;
  correct: boolean;
  eventId: string;
};

export function calculateMastery(attempts: Attempt[]) {
  const unique = [...new Map(attempts.map((attempt) => [attempt.eventId, attempt])).values()];
  const grouped = new Map<Principle, { correct: number; total: number }>();

  for (const attempt of unique) {
    const current = grouped.get(attempt.principle) ?? { correct: 0, total: 0 };
    current.total += 1;
    current.correct += attempt.correct ? 1 : 0;
    grouped.set(attempt.principle, current);
  }

  return Object.fromEntries(
    [...grouped].map(([principle, score]) => [
      principle,
      Math.round((score.correct / score.total) * 100),
    ]),
  );
}

