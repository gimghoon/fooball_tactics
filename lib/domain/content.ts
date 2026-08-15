export type ReviewStatus = "draft" | "pending" | "reviewed";

export function playableScenarios<T extends { reviewStatus: ReviewStatus }>(scenarios: T[]) {
  return scenarios.filter((scenario) => scenario.reviewStatus === "reviewed");
}

