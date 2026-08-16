import { assertReviewTransition, parseScenarioContent, type ReviewStatus } from "../domain/content.ts";

export type ScenarioReviewUpdate = {
  reviewStatus: ReviewStatus;
  sourceTitle: string | null;
  sourceUrl: string | null;
  reviewerName: string | null;
  reviewedAt: Date | null;
  reviewedContentJson: string | null;
};

export type ScenarioReviewDependencies = {
  env: {
    CONTENT_REVIEW_KEY?: string;
    CONTENT_REVIEWER_NAME?: string;
  };
  now: () => Date;
  findScenario: (id: string) => Promise<{ contentJson: string } | undefined>;
  updateScenario: (id: string, expectedContentJson: string, values: ScenarioReviewUpdate) => Promise<boolean>;
};

type ReviewBody = {
  status?: ReviewStatus;
  sourceTitle?: unknown;
  sourceUrl?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function handleReviewRequest(
  request: Request,
  context: { params: Promise<{ id: string }> },
  dependencies: ScenarioReviewDependencies,
): Promise<Response> {
  const expectedKey = text(dependencies.env.CONTENT_REVIEW_KEY);
  const reviewerName = text(dependencies.env.CONTENT_REVIEWER_NAME);
  if (!expectedKey || !reviewerName || request.headers.get("x-review-key") !== expectedKey) {
    return Response.json({ error: "검수 권한이 필요해요." }, { status: 401 });
  }

  let body: ReviewBody;
  try {
    body = await request.json() as ReviewBody;
  } catch {
    return Response.json({ error: "검수 요청을 확인할 수 없어요." }, { status: 400 });
  }
  if (!body.status || !["draft", "pending", "reviewed"].includes(body.status)) {
    return Response.json({ error: "검수 상태가 올바르지 않아요." }, { status: 400 });
  }

  const { id } = await context.params;
  const scenario = await dependencies.findScenario(id);
  if (!scenario) return Response.json({ error: "시나리오를 찾을 수 없어요." }, { status: 404 });

  let values: ScenarioReviewUpdate;
  if (body.status === "reviewed") {
    const sourceTitle = text(body.sourceTitle);
    const sourceUrl = text(body.sourceUrl);
    if (!sourceTitle || !sourceUrl) {
      return Response.json({ error: "시나리오 출처 제목과 URL이 필요합니다." }, { status: 409 });
    }
    if (scenario.contentJson.trim() === "") {
      return Response.json({ error: "시나리오 구조화 콘텐츠가 필요합니다." }, { status: 409 });
    }
    try {
      assertReviewTransition(body.status, parseScenarioContent(scenario.contentJson));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "시나리오 검수를 완료할 수 없습니다." }, { status: 409 });
    }
    values = {
      reviewStatus: body.status,
      sourceTitle,
      sourceUrl,
      reviewerName,
      reviewedAt: dependencies.now(),
      reviewedContentJson: scenario.contentJson,
    };
  } else {
    values = {
      reviewStatus: body.status,
      sourceTitle: null,
      sourceUrl: null,
      reviewerName: null,
      reviewedAt: null,
      reviewedContentJson: null,
    };
  }

  const updated = await dependencies.updateScenario(id, scenario.contentJson, values);
  if (!updated) {
    return Response.json({ error: "시나리오 콘텐츠가 변경되어 다시 검수해야 합니다." }, { status: 409 });
  }
  return Response.json({ id, reviewStatus: body.status });
}
