"use client";
/* eslint-disable jsx-a11y/label-has-associated-control */

import { useEffect, useRef, useState } from "react";
import { parseSpatialEvidenceJson } from "@/lib/domain/evidence";

type Source = {
  id: string;
  bundleId: string;
  originalFileName: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  extractionStatus: string;
  extractionError: string | null;
  origin?: "uploaded" | "external_web";
  canonicalUrl?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt?: number;
};
type Clip = {
  id?: string;
  url: string;
  startMs: number;
  endMs: number;
  observation: string;
};
type Job = {
  id: string;
  bundleId: string;
  inputVersion: string;
  status: "queued" | "running" | "review_ready" | "completed" | "failed";
  stage: string;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
  attemptCount: number;
  isStale: boolean;
  createdAt: number;
  updatedAt: number;
};
type Action = {
  action: "pass" | "dribble" | "move" | "hold" | "shoot";
  tacticalIntent?: string;
  actorId?: string | null;
  targetId?: string | null;
  trigger?: string | null;
  provenance?: string;
  confidence?: string;
  reason: string;
  citationIds: string[];
};
type CardContent = {
  situation: string;
  conditions: string[];
  defenseType: string;
  ballOwnerId?: string | null;
  cues: string[];
  preferred: Action[];
  alternatives: Action[];
  risky: Action[];
  confidence: string;
  uncertainties: string[];
  conflicts: string[];
  scenarioSuitable: boolean;
  animationSuitable: boolean;
};
type Citation = {
  chunkId: string;
  sourceId: string | null;
  videoClipId: string | null;
  locationLabel: string;
  excerpt: string;
  origin?: "uploaded" | "external_web" | "video_observation";
  canonicalUrl?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt?: number;
};
type Card = {
  id: string;
  bundleId: string;
  jobId: string;
  bundleVersion: number;
  status: string;
  content: CardContent;
  isStale: boolean;
  createdAt: number;
  updatedAt: number;
  citationCount: number;
  citations: Citation[];
};
type SearchStatus =
  "queued" | "searching" | "ready" | "importing" | "completed" | "failed";
type SearchCandidate = {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  canonicalUrl: string;
  documentType: "web_page" | "pdf";
  quote: string;
  relevance: string;
  trustTier: 1 | 2 | 3;
  rank: number;
  status:
    "candidate" | "selected" | "excluded" | "importing" | "imported" | "failed";
  failureReason: string | null;
};
type SafeSearchRunDetail = {
  run: {
    id: string;
    bundleId: string;
    bundleVersion: number;
    status: SearchStatus;
    errorMessage: string | null;
    isStale: boolean;
    startedAt: number | null;
    completedAt: number | null;
    createdAt: number;
    updatedAt: number;
  };
  candidates: SearchCandidate[];
};

export type EvidenceWizardBundle = {
  id: string;
  title: string;
  purpose: string;
  version: number;
  contentVersion: string;
  createdAt: number;
  updatedAt: number;
  sources?: Source[];
  videoClips?: Clip[];
  latestJob?: Job;
  latestSearch?: SafeSearchRunDetail;
  cards?: Card[];
};

type Requester = (path: string, init?: RequestInit) => Promise<unknown>;
type Props = {
  initialBundles: EvidenceWizardBundle[];
  initialBundleId?: string;
  request?: Requester;
};
type Step = "info" | "sources" | "search" | "analysis" | "review";

const steps: Array<{ id: Step; label: string; number: string }> = [
  { id: "info", label: "자료 정보", number: "01" },
  { id: "sources", label: "직접 근거", number: "02" },
  { id: "search", label: "외부 검색", number: "03" },
  { id: "analysis", label: "분석 확인", number: "04" },
  { id: "review", label: "카드 검수", number: "05" },
];
const defenseLabels: Record<string, string> = {
  front_press: "전방 압박",
  central_block: "중앙 차단",
  wide_funnel: "측면 유도",
  wide_trap: "측면 함정",
  one_v_one: "1대1",
  numerical_advantage: "수적 우위",
  numerical_disadvantage: "수적 열세",
  numerical_superiority: "수적 우위",
  numerical_inferiority: "수적 열세",
  zonal: "지역 수비",
  man_to_man: "대인 수비",
  double_team: "협력 수비",
  cover_shadow: "커버 섀도",
  transition_defense: "전환 수비",
  unknown: "수비 형태 미확인",
};
const actionLabels: Record<Action["action"], string> = {
  pass: "패스",
  dribble: "드리블",
  move: "이동",
  hold: "유지",
  shoot: "슛",
};
const intentLabels: Record<string, string> = {
  support: "지원",
  cover: "커버",
  press: "압박",
  delay: "지연",
  block_lane: "패스길 차단",
  hold_shape: "대형 유지",
  intercept: "가로채기",
  create_width: "폭 만들기",
  progress: "전진",
  retain_possession: "소유 유지",
  transition_attack: "공격 전환",
};

async function defaultRequest(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw new Error(body.error ?? "요청을 처리하지 못했습니다.");
  return body;
}

function timecode(value: string): number {
  const parts = value.trim().split(":").map(Number);
  if (
    parts.length !== 3 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  )
    throw new Error("시간은 HH:MM:SS 형식으로 입력해 주세요.");
  return ((parts[0]! * 60 + parts[1]!) * 60 + parts[2]!) * 1000;
}

function citationLabel(id: string): string {
  const suffix = id.match(/(\d+)$/)?.[1] ?? id.slice(0, 6);
  return `C-${suffix}`;
}

function allActions(content: CardContent): Action[] {
  return [...content.preferred, ...content.alternatives, ...content.risky];
}
function searchStatusLabel(status: SearchStatus): string {
  return {
    queued: "검색 대기",
    searching: "외부 출처 검색 중",
    ready: "후보 검토 준비",
    importing: "선택 출처 가져오는 중",
    completed: "외부 출처 등록 완료",
    failed: "외부 검색 중단",
  }[status];
}
function candidateStatusLabel(status: SearchCandidate["status"]): string {
  return {
    candidate: "후보",
    selected: "선택됨",
    excluded: "제외됨",
    importing: "가져오는 중",
    imported: "등록됨",
    failed: "실패",
  }[status];
}
function localSearch(
  run: { id: string; bundleId: string; status: SearchStatus },
  version: number,
): SafeSearchRunDetail {
  return {
    run: {
      ...run,
      bundleVersion: version,
      errorMessage: null,
      isStale: false,
      startedAt: null,
      completedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    candidates: [],
  };
}

export function EvidenceWizard({
  initialBundles,
  initialBundleId,
  request = defaultRequest,
}: Props) {
  const [bundles, setBundles] = useState(initialBundles);
  const [selectedId, setSelectedId] = useState(
    initialBundleId ?? initialBundles[0]?.id ?? "",
  );
  const [step, setStep] = useState<Step>(
    initialBundles.length ? "sources" : "info",
  );
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [clip, setClip] = useState({
    url: "",
    start: "00:00:00",
    end: "00:00:10",
    observation: "",
  });
  const [spatialJson, setSpatialJson] = useState("");
  const [impact, setImpact] = useState<{
    sourceId: string;
    cardCount: number;
    scenarioDraftCount: number;
  } | null>(null);
  const [candidateSelection, setCandidateSelection] = useState({
    runId: "",
    selected: [] as string[],
    excluded: [] as string[],
  });
  const [expandedQuotes, setExpandedQuotes] = useState<string[]>([]);
  const citationRefs = useRef(new Map<string, HTMLElement>());
  const selectedBundleIdRef = useRef(selectedId);
  const bundle = bundles.find((item) => item.id === selectedId);
  const job = bundle?.latestJob;
  const search = bundle?.latestSearch;
  const savedSelection = {
    selected:
      search?.candidates
        .filter((candidate) => candidate.status === "selected")
        .map((candidate) => candidate.id) ?? [],
    excluded:
      search?.candidates
        .filter((candidate) => candidate.status === "excluded")
        .map((candidate) => candidate.id) ?? [],
  };
  const selectedCandidateIds =
    candidateSelection.runId === search?.run.id
      ? candidateSelection.selected
      : savedSelection.selected;
  const excludedCandidateIds =
    candidateSelection.runId === search?.run.id
      ? candidateSelection.excluded
      : savedSelection.excluded;

  const updateBundle = (next: EvidenceWizardBundle) =>
    setBundles((current) => {
      const exists = current.some((item) => item.id === next.id);
      return exists
        ? current.map((item) =>
            item.id === next.id ? { ...item, ...next } : item,
          )
        : [next, ...current];
    });
  const loadBundle = async (id: string, includeLatestSearch = true) => {
    const result = (await request(`/api/admin/evidence/${id}`)) as {
      bundle: EvidenceWizardBundle;
      latestJob?: Job | null;
    };
    let next: EvidenceWizardBundle = {
      ...result.bundle,
      latestJob: result.latestJob ?? undefined,
    };
    if (includeLatestSearch) {
      const latestSearch = (await request(
        `/api/admin/evidence/${id}/search`,
      )) as { search: SafeSearchRunDetail | null };
      next = { ...next, latestSearch: latestSearch.search ?? undefined };
    }
    if (
      result.latestJob &&
      (result.latestJob.status === "review_ready" ||
        result.latestJob.status === "completed")
    ) {
      const status = (await request(
        `/api/admin/evidence/jobs/${result.latestJob.id}`,
      )) as { job: Job; cards?: Card[] };
      next = { ...next, latestJob: status.job, cards: status.cards ?? [] };
    }
    updateBundle(next);
  };
  const fail = (value: unknown) => {
    setError(
      value instanceof Error ? value.message : "요청을 처리하지 못했습니다.",
    );
    setMessage("");
  };

  useEffect(() => {
    selectedBundleIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (initialBundles.length > 0) return;
    let active = true;
    void request("/api/admin/evidence")
      .then((result) => {
        if (!active) return;
        const listed = (result as { bundles: EvidenceWizardBundle[] }).bundles;
        setBundles(listed);
        if (listed[0]) setSelectedId(listed[0].id);
      })
      .catch((value) => {
        if (active) fail(value);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId || bundle?.sources !== undefined) return;
    void Promise.resolve()
      .then(() => loadBundle(selectedId))
      .catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    let active = true;
    const bundleId = bundle?.id;
    const jobId = job.id;
    const poll = async () => {
      try {
        const result = (await request(`/api/admin/evidence/jobs/${jobId}`)) as {
          job: Job;
          cards?: Card[];
        };
        if (!active) return;
        setBundles((current) =>
          current.map((item) => {
            if (
              item.id !== bundleId ||
              selectedBundleIdRef.current !== bundleId ||
              item.latestJob?.id !== jobId
            )
              return item;
            return {
              ...item,
              latestJob: result.job,
              cards: result.cards ?? item.cards ?? [],
            };
          }),
        );
      } catch (value) {
        if (active) fail(value);
      }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  useEffect(() => {
    const run = search?.run;
    if (
      !bundle ||
      !run ||
      !["queued", "searching", "importing"].includes(run.status)
    )
      return;
    let active = true;
    let timer: number | undefined;
    const bundleId = bundle.id;
    const runId = run.id;
    const poll = async () => {
      try {
        const result = (await request(
          `/api/admin/evidence/${bundleId}/search/${runId}`,
        )) as { search: SafeSearchRunDetail };
        if (!active || result.search.run.id !== runId) return;
        let accepted = false;
        setBundles((current) =>
          current.map((item) => {
            if (
              item.id !== bundleId ||
              selectedBundleIdRef.current !== bundleId ||
              item.latestSearch?.run.id !== runId
            )
              return item;
            accepted = true;
            return { ...item, latestSearch: result.search };
          }),
        );
        if (!active || !accepted) return;
        if (result.search.run.status === "completed")
          void loadBundle(bundleId).catch(fail);
        if (
          active &&
          ["queued", "searching", "importing"].includes(
            result.search.run.status,
          )
        ) {
          timer = window.setTimeout(() => void poll(), 2000);
        }
      } catch (value) {
        if (active) fail(value);
      }
    };
    timer = window.setTimeout(() => void poll(), 2000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle?.id, search?.run.id, search?.run.status]);

  const inventoryReady = Boolean(
    bundle &&
    (bundle.sources?.length ?? 0) + (bundle.videoClips?.length ?? 0) > 0,
  );
  const directCount =
    bundle?.sources?.filter((source) => source.origin !== "external_web")
      .length ?? 0;
  const externalCount =
    bundle?.sources?.filter((source) => source.origin === "external_web")
      .length ?? 0;
  const cardReady = (card: Card) =>
    Boolean(
      !card.isStale &&
      card.content.confidence !== "low" &&
      card.content.conflicts.length === 0 &&
      allActions(card.content).every(
        (item) =>
          item.reason.trim() &&
          item.citationIds.length &&
          item.citationIds.every((id) =>
            card.citations.some((citation) => citation.chunkId === id),
          ),
      ),
    );

  const createBundle = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = (await request("/api/admin/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, purpose }),
      })) as { bundle: EvidenceWizardBundle };
      updateBundle({ ...result.bundle, sources: [], videoClips: [] });
      setSelectedId(result.bundle.id);
      setStep("sources");
      setMessage("근거 묶음을 만들었습니다.");
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    if (!bundle || files.length === 0) return;
    setBusy(true);
    setError("");
    try {
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith(".json")) continue;
        try {
          parseSpatialEvidenceJson(await file.text());
        } catch (value) {
          const reason =
            value instanceof Error
              ? value.message
              : "공간 전술 형식이 아닙니다.";
          throw new Error(
            `${file.name}: 지원하지 않는 공간 전술 JSON 형식입니다. ${reason}`,
          );
        }
      }
      const uploaded: Source[] = [];
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        const result = (await request(
          `/api/admin/evidence/${bundle.id}/files`,
          { method: "POST", body: form },
        )) as { source: Source };
        uploaded.push(result.source);
      }
      const merged = [...(bundle.sources ?? [])];
      for (const source of uploaded) {
        const existing = merged.findIndex(
          (item) => item.contentHash === source.contentHash,
        );
        if (existing >= 0) merged[existing] = source;
        else merged.push(source);
      }
      updateBundle({ ...bundle, sources: merged });
      await loadBundle(bundle.id, false);
      setMessage(`${files.length}개 파일을 등록했습니다.`);
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  };

  const addSpatialJson = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bundle) return;
    setBusy(true);
    setError("");
    try {
      const json = String(
        new FormData(event.currentTarget as HTMLFormElement).get(
          "spatial-json",
        ) ?? "",
      );
      parseSpatialEvidenceJson(json);
      const file = new File([json], `spatial-evidence-${Date.now()}.json`, {
        type: "application/json",
      });
      const form = new FormData();
      form.set("file", file);
      const result = (await request(`/api/admin/evidence/${bundle.id}/files`, {
        method: "POST",
        body: form,
      })) as { source: Source };
      updateBundle({
        ...bundle,
        sources: [
          ...(bundle.sources ?? []).filter(
            (item) => item.contentHash !== result.source.contentHash,
          ),
          result.source,
        ],
      });
      setSpatialJson("");
      setMessage("JSON 근거를 등록했습니다.");
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const addClip = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bundle) return;
    setBusy(true);
    setError("");
    try {
      const result = (await request(`/api/admin/evidence/${bundle.id}/clips`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: clip.url,
          startMs: timecode(clip.start),
          endMs: timecode(clip.end),
          observation: clip.observation,
        }),
      })) as { bundle: EvidenceWizardBundle };
      await loadBundle(result.bundle.id);
      setClip({ url: "", start: "00:00:00", end: "00:00:10", observation: "" });
      setMessage("영상 구간을 등록했습니다.");
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const startAnalysis = async () => {
    if (!bundle || !confirmation) return;
    setBusy(true);
    setError("");
    try {
      const result = (await request(
        `/api/admin/evidence/${bundle.id}/analyze`,
        { method: "POST" },
      )) as { job: Job };
      updateBundle({ ...bundle, latestJob: result.job, cards: [] });
      setMessage("등록한 근거만으로 분석을 시작했습니다.");
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const retryJob = async () => {
    if (!job || !bundle) return;
    setBusy(true);
    try {
      const result = (await request(`/api/admin/evidence/jobs/${job.id}`, {
        method: "POST",
      })) as { job: Job };
      updateBundle({ ...bundle, latestJob: result.job });
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const startSearch = async () => {
    if (!bundle) return;
    setBusy(true);
    setError("");
    try {
      const result = (await request(`/api/admin/evidence/${bundle.id}/search`, {
        method: "POST",
      })) as { search: { id: string; bundleId: string; status: SearchStatus } };
      updateBundle({
        ...bundle,
        latestSearch: localSearch(result.search, bundle.version),
      });
      setCandidateSelection({
        runId: result.search.id,
        selected: [],
        excluded: [],
      });
      setMessage(
        "외부 출처 검색을 시작했습니다. 검색이 끝나면 후보를 직접 고릅니다.",
      );
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const saveSelection = async (
    selectedIds = selectedCandidateIds,
    excludedIds = excludedCandidateIds,
  ): Promise<SafeSearchRunDetail | null> => {
    if (!bundle || !search) return null;
    const result = (await request(
      `/api/admin/evidence/${bundle.id}/search/${search.run.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedBundleVersion: bundle.version,
          selectedIds,
          excludedIds,
        }),
      },
    )) as { search: SafeSearchRunDetail };
    updateBundle({ ...bundle, latestSearch: result.search });
    setMessage(`선택 ${selectedIds.length}개를 저장했습니다.`);
    return result.search;
  };

  const saveSearchSelection = async () => {
    setBusy(true);
    setError("");
    try {
      await saveSelection();
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const importSelection = async () => {
    if (!bundle || !search || selectedCandidateIds.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const saved = await saveSelection();
      if (!saved) return;
      const result = (await request(
        `/api/admin/evidence/${bundle.id}/search/${saved.run.id}/import`,
        { method: "POST" },
      )) as { search: { id: string; bundleId: string; status: SearchStatus } };
      updateBundle({
        ...bundle,
        latestSearch: localSearch(result.search, bundle.version),
      });
      setMessage("선택한 외부 출처를 가져오고 있습니다.");
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const retryFailedCandidate = async (candidate: SearchCandidate) => {
    if (!bundle || !search || candidate.status !== "failed") return;
    setBusy(true);
    setError("");
    try {
      const saved = await saveSelection([candidate.id], []);
      if (!saved) return;
      const result = (await request(
        `/api/admin/evidence/${bundle.id}/search/${saved.run.id}/import`,
        { method: "POST" },
      )) as { search: { id: string; bundleId: string; status: SearchStatus } };
      updateBundle({
        ...bundle,
        latestSearch: localSearch(result.search, bundle.version),
      });
      setCandidateSelection({
        runId: result.search.id,
        selected: [candidate.id],
        excluded: [],
      });
      setMessage("실패한 출처를 다시 가져오고 있습니다.");
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const toggleCandidate = (candidate: SearchCandidate) => {
    if (["importing", "imported"].includes(candidate.status)) return;
    const selected = selectedCandidateIds.includes(candidate.id);
    if (!selected && selectedCandidateIds.length >= 5) {
      setError("외부 출처는 최대 5개까지 선택할 수 있습니다.");
      setMessage("");
      return;
    }
    setCandidateSelection({
      runId: search?.run.id ?? "",
      selected: selected
        ? selectedCandidateIds.filter((id) => id !== candidate.id)
        : [...selectedCandidateIds, candidate.id],
      excluded: excludedCandidateIds.filter((id) => id !== candidate.id),
    });
    setError("");
  };

  const excludeCandidate = (candidate: SearchCandidate) => {
    if (["importing", "imported"].includes(candidate.status)) return;
    setCandidateSelection({
      runId: search?.run.id ?? "",
      selected: selectedCandidateIds.filter((id) => id !== candidate.id),
      excluded: excludedCandidateIds.includes(candidate.id)
        ? excludedCandidateIds.filter((id) => id !== candidate.id)
        : [...excludedCandidateIds, candidate.id],
    });
  };

  const review = async (
    card: Card,
    status: "owner_reviewed" | "held" | "rejected",
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = (await request(
        `/api/admin/evidence/cards/${card.id}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status,
            content: card.content,
            expectedUpdatedAt: card.updatedAt,
          }),
        },
      )) as { card: Card };
      updateBundle({
        ...bundle!,
        cards: bundle!.cards!.map((item) =>
          item.id === card.id ? { ...item, ...result.card } : item,
        ),
      });
      setMessage(
        status === "owner_reviewed"
          ? "본인 검수를 기록했습니다."
          : "검수 상태를 저장했습니다.",
      );
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  const inspectDelete = async (sourceId: string) => {
    if (!bundle) return;
    try {
      const result = (await request(
        `/api/admin/evidence/${bundle.id}/files/${sourceId}/impact`,
      )) as { impact: { cardIds: string[]; scenarioDraftIds: string[] } };
      setImpact({
        sourceId,
        cardCount: result.impact.cardIds.length,
        scenarioDraftCount: result.impact.scenarioDraftIds.length,
      });
    } catch (value) {
      fail(value);
    }
  };
  const deleteSource = async () => {
    if (!bundle || !impact || impact.cardCount + impact.scenarioDraftCount > 0)
      return;
    setBusy(true);
    try {
      await request(
        `/api/admin/evidence/${bundle.id}/files/${impact.sourceId}`,
        { method: "DELETE" },
      );
      updateBundle({
        ...bundle,
        sources: bundle.sources?.filter((item) => item.id !== impact.sourceId),
      });
      setImpact(null);
      setMessage("근거 파일을 삭제했습니다.");
    } catch (value) {
      fail(value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="evidence-admin-shell">
      <header className="evidence-admin-header">
        <div>
          <span className="evidence-kicker">TACTIQ · COACH DESK</span>
          <h1>근거로 만드는 전술 카드</h1>
          <p>LLM은 초안을 정리하고, 최종 판단은 운영자와 코치가 직접 합니다.</p>
        </div>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/">훈련 화면으로</a>
      </header>
      <nav className="evidence-steps" aria-label="근거 등록 단계">
        {steps.map((item) => (
          <button
            key={item.id}
            className={step === item.id ? "is-current" : ""}
            aria-current={step === item.id ? "step" : undefined}
            onClick={() => setStep(item.id)}
          >
            <span>{item.number}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="evidence-layout">
        <aside className="bundle-rail">
          <div className="rail-title">
            <strong>근거 묶음</strong>
            <button
              onClick={() => {
                setSelectedId("");
                setStep("info");
              }}
            >
              새로 만들기
            </button>
          </div>
          {bundles.map((item) => (
            <button
              key={item.id}
              className={selectedId === item.id ? "is-selected" : ""}
              onClick={() => {
                setSelectedId(item.id);
                setConfirmation(false);
              }}
            >
              <strong>{item.title}</strong>
              <small>
                v{item.version} · {item.purpose}
              </small>
            </button>
          ))}
        </aside>
        <section className="evidence-workspace">
          {(message || error) && (
            <div
              aria-live="polite"
              role={error ? "alert" : undefined}
              className={error ? "evidence-alert error" : "evidence-alert"}
            >
              {error || message}
            </div>
          )}
          {step === "info" && (
            <form className="evidence-panel form-panel" onSubmit={createBundle}>
              <span className="panel-number">01 · 자료 정보</span>
              <h2>어떤 판단을 훈련할 자료인가요?</h2>
              <label>
                묶음 이름
                <input
                  required
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="예: 전방 압박에서 픽소의 선택"
                />
              </label>
              <label>
                훈련 목적
                <textarea
                  required
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  placeholder="선수가 경기에서 개선해야 할 판단을 한 문장으로 적어주세요."
                />
              </label>
              <div className="guideline">
                <strong>좋은 근거 묶음</strong>
                <ul>
                  <li>하나의 전술 원칙과 하나의 학습 목표에 집중합니다.</li>
                  <li>
                    원문, 페이지 또는 영상 시간대를 확인할 수 있어야 합니다.
                  </li>
                  <li>서로 다른 코치 의견은 지우지 않고 충돌로 남깁니다.</li>
                </ul>
              </div>
              <button className="evidence-primary" disabled={busy}>
                묶음 만들고 근거 추가
              </button>
            </form>
          )}
          {step === "sources" && (
            <div className="evidence-panel">
              <span className="panel-number">02 · 직접 근거</span>
              <h2>원문과 관찰을 함께 등록하세요</h2>
              {!bundle ? (
                <p>먼저 자료 정보에서 근거 묶음을 만들어 주세요.</p>
              ) : (
                <>
                  <div className="upload-drop">
                    <input
                      id="evidence-files"
                      type="file"
                      multiple
                      accept=".pdf,.txt,.md,.markdown,.json,application/pdf,application/json,text/plain,text/markdown"
                      onChange={upload}
                      disabled={busy}
                    />
                    <label htmlFor="evidence-files">
                      <strong>PDF · TXT · Markdown · JSON 업로드</strong>
                      <span>
                        파일당 최대 20MB · JSON은 공간 전술 표준 형식만 허용
                      </span>
                    </label>
                  </div>
                  <form
                    className="clip-form json-form"
                    onSubmit={addSpatialJson}
                  >
                    <h3>공간 전술 JSON 붙여넣기</h3>
                    <p>
                      선수 좌표, 수비 형태, 판단 단서와 행동 경로를 포함한 표준
                      JSON을 검사한 뒤 저장합니다.
                    </p>
                    <label>
                      JSON 원문
                      <textarea
                        name="spatial-json"
                        required
                        value={spatialJson}
                        onChange={(event) => setSpatialJson(event.target.value)}
                        placeholder={
                          '{\n  "source": { ... },\n  "coordinateSystem": { ... },\n  "scene": { ... }\n}'
                        }
                      />
                    </label>
                    <button disabled={busy || !spatialJson.trim()}>
                      JSON 근거 저장
                    </button>
                  </form>
                  <div className="source-list">
                    {(bundle.sources ?? []).map((source) => (
                      <article key={source.id}>
                        <div>
                          <strong>{source.originalFileName}</strong>
                          <small>
                            {Math.ceil(source.byteSize / 1024)}KB ·{" "}
                            {source.extractionStatus === "completed"
                              ? "텍스트 준비됨"
                              : "원문 보관 · OCR 필요"}
                          </small>
                        </div>
                        <a
                          href={`/api/admin/evidence/${bundle.id}/files/${source.id}`}
                        >
                          원문
                        </a>
                        <button onClick={() => void inspectDelete(source.id)}>
                          삭제
                        </button>
                      </article>
                    ))}
                  </div>
                  <form className="clip-form" onSubmit={addClip}>
                    <h3>영상 구간 직접 기록</h3>
                    <label>
                      HTTPS 영상 URL
                      <input
                        required
                        type="url"
                        value={clip.url}
                        onChange={(event) =>
                          setClip({ ...clip, url: event.target.value })
                        }
                      />
                    </label>
                    <div>
                      <label>
                        시작
                        <input
                          required
                          value={clip.start}
                          onChange={(event) =>
                            setClip({ ...clip, start: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        종료
                        <input
                          required
                          value={clip.end}
                          onChange={(event) =>
                            setClip({ ...clip, end: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <label>
                      이 구간에서 확인한 사실
                      <textarea
                        required
                        value={clip.observation}
                        onChange={(event) =>
                          setClip({ ...clip, observation: event.target.value })
                        }
                      />
                    </label>
                    <button disabled={busy}>영상 구간 추가</button>
                  </form>
                  <button
                    className="evidence-primary"
                    disabled={!inventoryReady}
                    onClick={() => setStep("search")}
                  >
                    외부 출처 검토하기
                  </button>
                </>
              )}
            </div>
          )}
          {step === "search" && (
            <div className="evidence-panel search-panel">
              <span className="panel-number">03 · 외부 검색</span>
              <h2>외부 출처는 직접 검토한 뒤 보충하세요</h2>
              {!bundle ? (
                <p>먼저 자료 정보에서 근거 묶음을 만들어 주세요.</p>
              ) : (
                <>
                  <p className="search-guidance">
                    검색은 버튼을 누를 때만 시작합니다. 후보와 원문을 확인하고
                    최대 5개만 선택하세요.
                  </p>
                  {search ? (
                    <div
                      className={`job-status search-status ${search.run.status}`}
                      aria-live="polite"
                    >
                      <strong>{searchStatusLabel(search.run.status)}</strong>
                      <span>
                        {search.run.isStale
                          ? "자료 변경으로 이전 검색입니다."
                          : "검색 결과와 가져오기 상태를 여기에서 확인합니다."}
                      </span>
                      {search.run.errorMessage && (
                        <p role="alert">{search.run.errorMessage}</p>
                      )}
                      {search.run.status === "failed" &&
                        search.candidates.length === 0 && (
                          <button
                            onClick={() => void startSearch()}
                            disabled={busy}
                          >
                            다시 시도
                          </button>
                        )}
                    </div>
                  ) : (
                    <button
                      className="evidence-primary"
                      onClick={() => void startSearch()}
                      disabled={busy}
                    >
                      외부 출처 찾기
                    </button>
                  )}
                  {search && search.candidates.length > 0 && (
                    <>
                      <div className="selection-summary" aria-live="polite">
                        <strong>선택 {selectedCandidateIds.length}/5</strong>
                        <span>
                          선택한 출처만 저장하거나 가져올 수 있습니다.
                        </span>
                      </div>
                      <div className="candidate-list">
                        {search.candidates.map((candidate) => {
                          const selected = selectedCandidateIds.includes(
                            candidate.id,
                          );
                          const excluded = excludedCandidateIds.includes(
                            candidate.id,
                          );
                          const expanded = expandedQuotes.includes(
                            candidate.id,
                          );
                          return (
                            <article
                              className="candidate-card"
                              key={candidate.id}
                            >
                              <label className="candidate-select">
                                <input
                                  type="checkbox"
                                  value={candidate.id}
                                  checked={selected}
                                  disabled={
                                    busy ||
                                    candidate.status === "importing" ||
                                    candidate.status === "imported"
                                  }
                                  onChange={() => toggleCandidate(candidate)}
                                />
                                <span>
                                  <strong>{candidate.title}</strong>
                                  <small>
                                    {candidateStatusLabel(
                                      selected
                                        ? "selected"
                                        : excluded
                                          ? "excluded"
                                          : candidate.status,
                                    )}
                                  </small>
                                </span>
                              </label>
                              <p>
                                {candidate.publisher} · {candidate.publishedAt}{" "}
                                ·{" "}
                                {candidate.documentType === "pdf"
                                  ? "PDF"
                                  : "웹"}{" "}
                                · 서버 신뢰 등급 {candidate.trustTier}
                              </p>
                              <blockquote
                                className={expanded ? "is-expanded" : ""}
                              >
                                {candidate.quote}
                              </blockquote>
                              {candidate.quote.length > 160 && (
                                <button
                                  className="quote-toggle"
                                  onClick={() =>
                                    setExpandedQuotes((current) =>
                                      current.includes(candidate.id)
                                        ? current.filter(
                                            (id) => id !== candidate.id,
                                          )
                                        : [...current, candidate.id],
                                    )
                                  }
                                >
                                  {expanded ? "인용 접기" : "인용 펼치기"}
                                </button>
                              )}
                              <p>관련성: {candidate.relevance}</p>
                              <a
                                href={candidate.canonicalUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                새 탭에서 원문 보기
                              </a>
                              <button
                                className="candidate-exclude"
                                onClick={() => excludeCandidate(candidate)}
                                disabled={
                                  busy ||
                                  candidate.status === "importing" ||
                                  candidate.status === "imported"
                                }
                              >
                                {excluded ? "제외 취소" : "제외"}
                              </button>
                              {candidate.status === "failed" && (
                                <button
                                  className="candidate-retry"
                                  onClick={() =>
                                    void retryFailedCandidate(candidate)
                                  }
                                  disabled={busy}
                                >
                                  실패한 출처 다시 시도
                                </button>
                              )}
                              {candidate.failureReason && (
                                <p role="alert">{candidate.failureReason}</p>
                              )}
                            </article>
                          );
                        })}
                      </div>
                      {search.run.status === "ready" && (
                        <div className="search-actions">
                          <button
                            onClick={() => void saveSearchSelection()}
                            disabled={busy}
                          >
                            선택 저장
                          </button>
                          <button
                            className="evidence-primary"
                            onClick={() => void importSelection()}
                            disabled={busy || selectedCandidateIds.length === 0}
                          >
                            선택 출처 가져오기
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {search?.run.status === "completed" && (
                    <p aria-live="polite">
                      외부 보충 출처 등록이 끝났습니다. 아래에서 분석 범위를
                      확인하세요.
                    </p>
                  )}
                  <button
                    className="direct-only"
                    onClick={() => setStep("analysis")}
                  >
                    외부 출처 없이 분석 확인
                  </button>
                </>
              )}
            </div>
          )}
          {step === "analysis" && (
            <div className="evidence-panel">
              <span className="panel-number">04 · 분석 확인</span>
              <h2>분석 범위를 마지막으로 확인하세요</h2>
              {!bundle ? (
                <p>선택한 근거 묶음이 없습니다.</p>
              ) : (
                <>
                  <div className="inventory">
                    <strong>{bundle.title}</strong>
                    <span>
                      직접 등록 {directCount}개 · 외부 보충 {externalCount}개 ·
                      영상 관찰 {bundle.videoClips?.length ?? 0}개
                    </span>
                    {(bundle.sources ?? []).map((source) => (
                      <p key={source.id}>
                        {source.origin === "external_web"
                          ? "외부 보충"
                          : "직접 등록"}{" "}
                        · {source.originalFileName}
                      </p>
                    ))}
                    {(bundle.videoClips ?? []).map((item, index) => (
                      <p key={item.id ?? index}>
                        영상 관찰 · {item.url} · {item.observation}
                      </p>
                    ))}
                  </div>
                  <label className="confirm-row">
                    <input
                      aria-label="아래에서 확인한 직접·외부 근거와 영상 관찰만 분석한다는 점을 확인했습니다"
                      name="analysis-confirmation"
                      type="checkbox"
                      checked={confirmation}
                      onChange={(event) =>
                        setConfirmation(event.target.checked)
                      }
                    />
                    <span>
                      <strong>
                        아래에서 확인한 직접·외부 근거와 영상 관찰만 분석한다는
                        점을 확인했습니다
                      </strong>
                      <small>
                        인터넷 지식이나 출처 없는 전술 설명은 정답으로 사용하지
                        않습니다.
                      </small>
                    </span>
                  </label>
                  <button
                    className="evidence-primary"
                    disabled={
                      !inventoryReady ||
                      !confirmation ||
                      busy ||
                      job?.status === "running" ||
                      job?.status === "queued"
                    }
                    onClick={() => void startAnalysis()}
                  >
                    분석 시작
                  </button>
                  {job && (
                    <div
                      className={`job-status ${job.status}`}
                      aria-live="polite"
                    >
                      <strong>
                        {job.status === "review_ready"
                          ? "카드 검수 준비 완료"
                          : job.status === "failed"
                            ? "분석 중단"
                            : "근거 분석 중"}
                      </strong>
                      <span>
                        단계: {job.stage} · 시도 {job.attemptCount}회
                      </span>
                      {job.isStale && (
                        <p role="alert">
                          자료가 변경되어 이 분석은 오래된 버전입니다.
                        </p>
                      )}
                      {job.status === "failed" && (
                        <button onClick={() => void retryJob()}>
                          분석 다시 시도
                        </button>
                      )}
                      {job.status === "review_ready" && (
                        <button onClick={() => setStep("review")}>
                          카드 검수로 이동
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {step === "review" && (
            <div className="evidence-panel review-panel">
              <span className="panel-number">05 · 카드 검수</span>
              <h2>근거와 설명을 나란히 확인하세요</h2>
              {!bundle?.cards?.length ? (
                <p className="empty-review">
                  분석이 완료되면 검수할 카드가 여기에 표시됩니다.
                </p>
              ) : (
                bundle.cards.map((card) => (
                  <article className="review-card" key={card.id}>
                    <header>
                      <div>
                        <span>
                          {defenseLabels[card.content.defenseType] ??
                            card.content.defenseType}
                        </span>
                        <h3>{card.content.situation}</h3>
                      </div>
                      <em>
                        {card.content.confidence === "high"
                          ? "높은 확신"
                          : card.content.confidence === "medium"
                            ? "중간 확신"
                            : "낮은 확신"}
                      </em>
                    </header>
                    <div className="review-columns">
                      <section aria-label="출처 근거">
                        <h4>코치 원문 근거</h4>
                        {card.citations.map((citation) => (
                          <div
                            key={citation.chunkId}
                            ref={(node) => {
                              if (node)
                                citationRefs.current.set(
                                  citation.chunkId,
                                  node,
                                );
                            }}
                            className="citation-excerpt"
                            id={`citation-${citation.chunkId}`}
                          >
                            <strong>
                              근거 {citationLabel(citation.chunkId)} ·{" "}
                              {citation.locationLabel}
                            </strong>
                            <span className="origin-badge">
                              {citation.origin === "external_web"
                                ? "외부 보충"
                                : citation.origin === "video_observation"
                                  ? "영상 관찰"
                                  : "직접 등록"}
                            </span>
                            <span>{citation.excerpt}</span>
                            {citation.origin === "external_web" &&
                              citation.publisher &&
                              citation.publishedAt &&
                              citation.retrievedAt &&
                              citation.canonicalUrl && (
                                <small>
                                  {citation.publisher} · 게시{" "}
                                  {citation.publishedAt} · 수집{" "}
                                  {new Date(
                                    citation.retrievedAt,
                                  ).toLocaleDateString("ko-KR")}
                                </small>
                              )}
                            {citation.origin === "external_web" &&
                              citation.canonicalUrl && (
                                <a
                                  href={citation.canonicalUrl}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                >
                                  새 탭에서 원문 보기
                                </a>
                              )}
                          </div>
                        ))}
                      </section>
                      <section aria-label="전술 카드 설명">
                        <h4>선수에게 보여줄 설명</h4>
                        <dl>
                          <dt>조건</dt>
                          <dd>
                            {card.content.conditions.join(" · ") || "없음"}
                          </dd>
                          <dt>관찰 단서</dt>
                          <dd>{card.content.cues.join(" · ") || "없음"}</dd>
                        </dl>
                        {(["preferred", "alternatives", "risky"] as const).map(
                          (group) =>
                            card.content[group].map((item, index) => (
                              <div
                                className={`action-reason ${group}`}
                                key={`${group}-${index}`}
                              >
                                <strong>
                                  {actionLabels[item.action]}
                                  {item.tacticalIntent
                                    ? ` · ${intentLabels[item.tacticalIntent] ?? item.tacticalIntent}`
                                    : ""}{" "}
                                  {group === "preferred"
                                    ? "권장 이유"
                                    : group === "alternatives"
                                      ? "대안 이유"
                                      : "주의 이유"}
                                </strong>
                                {item.actorId && (
                                  <small>
                                    {item.actorId}
                                    {item.targetId ? ` → ${item.targetId}` : ""}
                                    {item.trigger
                                      ? ` · 조건: ${item.trigger}`
                                      : ""}
                                  </small>
                                )}
                                <p>{item.reason}</p>
                                <div>
                                  {item.citationIds.map((id) => (
                                    <button
                                      key={id}
                                      onClick={() =>
                                        citationRefs.current
                                          .get(id)
                                          ?.scrollIntoView({
                                            behavior: "smooth",
                                            block: "center",
                                          })
                                      }
                                    >
                                      근거 {citationLabel(id)}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )),
                        )}
                      </section>
                    </div>
                    <div className="animation-memory">
                      <strong>직관적 애니메이션 설명</strong>
                      <ol>
                        <li>
                          <span>관찰</span>수비 위치와 열린 공간을 본다
                        </li>
                        <li>
                          <span>선택</span>신체 행동과 전술 의도를 함께 확인한다
                        </li>
                        <li>
                          <span>결과</span>경로·대상·발동 조건이 어떻게
                          연결되는지 본다
                        </li>
                        <li>
                          <span>기억</span>경기에서 확인할 한 문장으로 남긴다
                        </li>
                      </ol>
                    </div>
                    {card.content.conflicts.length > 0 && (
                      <p role="alert" className="conflict">
                        미해결 충돌: {card.content.conflicts.join(" · ")}
                      </p>
                    )}
                    <footer>
                      <button onClick={() => void review(card, "rejected")}>
                        반려
                      </button>
                      <button onClick={() => void review(card, "held")}>
                        보류
                      </button>
                      <button
                        className="approve"
                        disabled={!cardReady(card) || busy}
                        onClick={() => void review(card, "owner_reviewed")}
                      >
                        본인 검수 완료
                      </button>
                    </footer>
                  </article>
                ))
              )}
            </div>
          )}
        </section>
      </div>
      {impact && (
        <div className="evidence-dialog-backdrop">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            className="evidence-dialog"
          >
            <h2 id="delete-title">근거 삭제 영향 확인</h2>
            <p>
              연결된 카드 {impact.cardCount}개 · 시나리오 초안{" "}
              {impact.scenarioDraftCount}개
            </p>
            {impact.cardCount + impact.scenarioDraftCount > 0 && (
              <p role="alert">연결된 검수 기록이 있어 삭제할 수 없습니다.</p>
            )}
            <div>
              <button onClick={() => setImpact(null)}>취소</button>
              <button
                className="danger"
                disabled={
                  busy || impact.cardCount + impact.scenarioDraftCount > 0
                }
                onClick={() => void deleteSource()}
              >
                삭제 확인
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
