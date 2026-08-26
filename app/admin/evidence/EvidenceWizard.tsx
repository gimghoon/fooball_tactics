"use client";

import { useEffect, useRef, useState } from "react";
import { parseSpatialEvidenceJson } from "@/lib/domain/evidence";

type Source = { id: string; bundleId: string; originalFileName: string; mediaType: string; byteSize: number; contentHash: string; extractionStatus: string; extractionError: string | null };
type Clip = { id?: string; url: string; startMs: number; endMs: number; observation: string };
type Job = { id: string; bundleId: string; inputVersion: string; status: "queued" | "running" | "review_ready" | "completed" | "failed"; stage: string; errorMessage: string | null; startedAt: number | null; completedAt: number | null; attemptCount: number; isStale: boolean; createdAt: number; updatedAt: number };
type Action = { action: "pass" | "dribble" | "move" | "hold" | "shoot"; tacticalIntent?: string; actorId?: string | null; targetId?: string | null; trigger?: string | null; provenance?: string; confidence?: string; reason: string; citationIds: string[] };
type CardContent = { situation: string; conditions: string[]; defenseType: string; ballOwnerId?: string | null; cues: string[]; preferred: Action[]; alternatives: Action[]; risky: Action[]; confidence: string; uncertainties: string[]; conflicts: string[]; scenarioSuitable: boolean; animationSuitable: boolean };
type Citation = { chunkId: string; sourceId: string | null; videoClipId: string | null; locationLabel: string; excerpt: string };
type Card = { id: string; bundleId: string; jobId: string; bundleVersion: number; status: string; content: CardContent; isStale: boolean; createdAt: number; updatedAt: number; citationCount: number; citations: Citation[] };

export type EvidenceWizardBundle = {
  id: string; title: string; purpose: string; version: number; contentVersion: string; createdAt: number; updatedAt: number;
  sources?: Source[]; videoClips?: Clip[]; latestJob?: Job; cards?: Card[];
};

type Requester = (path: string, init?: RequestInit) => Promise<unknown>;
type Props = { initialBundles: EvidenceWizardBundle[]; initialBundleId?: string; request?: Requester };
type Step = "info" | "sources" | "analysis" | "review";

const steps: Array<{ id: Step; label: string; number: string }> = [
  { id: "info", label: "자료 정보", number: "01" },
  { id: "sources", label: "근거 추가", number: "02" },
  { id: "analysis", label: "분석 확인", number: "03" },
  { id: "review", label: "카드 검수", number: "04" },
];
const defenseLabels: Record<string, string> = { front_press: "전방 압박", central_block: "중앙 차단", wide_funnel: "측면 유도", wide_trap: "측면 함정", one_v_one: "1대1", numerical_advantage: "수적 우위", numerical_disadvantage: "수적 열세", numerical_superiority: "수적 우위", numerical_inferiority: "수적 열세", zonal: "지역 수비", man_to_man: "대인 수비", double_team: "협력 수비", cover_shadow: "커버 섀도", transition_defense: "전환 수비", unknown: "수비 형태 미확인" };
const actionLabels: Record<Action["action"], string> = { pass: "패스", dribble: "드리블", move: "이동", hold: "유지", shoot: "슛" };
const intentLabels: Record<string, string> = { support: "지원", cover: "커버", press: "압박", delay: "지연", block_lane: "패스길 차단", hold_shape: "대형 유지", intercept: "가로채기", create_width: "폭 만들기", progress: "전진", retain_possession: "소유 유지", transition_attack: "공격 전환" };

async function defaultRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "요청을 처리하지 못했습니다.");
  return body;
}

function timecode(value: string): number {
  const parts = value.trim().split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) throw new Error("시간은 HH:MM:SS 형식으로 입력해 주세요.");
  return ((parts[0]! * 60 + parts[1]!) * 60 + parts[2]!) * 1000;
}

function citationLabel(id: string): string {
  const suffix = id.match(/(\d+)$/)?.[1] ?? id.slice(0, 6);
  return `C-${suffix}`;
}

function allActions(content: CardContent): Action[] { return [...content.preferred, ...content.alternatives, ...content.risky]; }

export function EvidenceWizard({ initialBundles, initialBundleId, request = defaultRequest }: Props) {
  const [bundles, setBundles] = useState(initialBundles);
  const [selectedId, setSelectedId] = useState(initialBundleId ?? initialBundles[0]?.id ?? "");
  const [step, setStep] = useState<Step>(initialBundles.length ? "sources" : "info");
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [clip, setClip] = useState({ url: "", start: "00:00:00", end: "00:00:10", observation: "" });
  const [spatialJson, setSpatialJson] = useState("");
  const [impact, setImpact] = useState<{ sourceId: string; cardCount: number; scenarioDraftCount: number } | null>(null);
  const citationRefs = useRef(new Map<string, HTMLElement>());
  const bundle = bundles.find((item) => item.id === selectedId);
  const job = bundle?.latestJob;

  const updateBundle = (next: EvidenceWizardBundle) => setBundles((current) => {
    const exists = current.some((item) => item.id === next.id);
    return exists ? current.map((item) => item.id === next.id ? { ...item, ...next } : item) : [next, ...current];
  });
  const loadBundle = async (id: string) => {
    const result = await request(`/api/admin/evidence/${id}`) as { bundle: EvidenceWizardBundle; latestJob?: Job | null };
    let next = { ...result.bundle, latestJob: result.latestJob ?? undefined };
    if (result.latestJob && (result.latestJob.status === "review_ready" || result.latestJob.status === "completed")) {
      const status = await request(`/api/admin/evidence/jobs/${result.latestJob.id}`) as { job: Job; cards?: Card[] };
      next = { ...next, latestJob: status.job, cards: status.cards ?? [] };
    }
    updateBundle(next);
  };
  const fail = (value: unknown) => { setError(value instanceof Error ? value.message : "요청을 처리하지 못했습니다."); setMessage(""); };

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
      .catch((value) => { if (active) fail(value); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId || bundle?.sources !== undefined) return;
    void Promise.resolve().then(() => loadBundle(selectedId)).catch(fail);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    let active = true;
    const poll = async () => {
      try {
        const result = await request(`/api/admin/evidence/jobs/${job.id}`) as { job: Job; cards?: Card[] };
        if (!active) return;
        updateBundle({ ...bundle!, latestJob: result.job, cards: result.cards ?? bundle?.cards ?? [] });
      } catch (value) { if (active) fail(value); }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  const inventoryReady = Boolean(bundle && ((bundle.sources?.length ?? 0) + (bundle.videoClips?.length ?? 0) > 0));
  const cardReady = (card: Card) => Boolean(!card.isStale && card.content.confidence !== "low" && card.content.conflicts.length === 0 && allActions(card.content).every((item) => item.reason.trim() && item.citationIds.length && item.citationIds.every((id) => card.citations.some((citation) => citation.chunkId === id))));

  const createBundle = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await request("/api/admin/evidence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, purpose }) }) as { bundle: EvidenceWizardBundle };
      updateBundle({ ...result.bundle, sources: [], videoClips: [] }); setSelectedId(result.bundle.id); setStep("sources"); setMessage("근거 묶음을 만들었습니다.");
    } catch (value) { fail(value); } finally { setBusy(false); }
  };

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]; if (!bundle || files.length === 0) return;
    setBusy(true); setError("");
    try {
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith(".json")) continue;
        try { parseSpatialEvidenceJson(await file.text()); }
        catch (value) {
          const reason = value instanceof Error ? value.message : "공간 전술 형식이 아닙니다.";
          throw new Error(`${file.name}: 지원하지 않는 공간 전술 JSON 형식입니다. ${reason}`);
        }
      }
      const uploaded: Source[] = [];
      for (const file of files) {
        const form = new FormData(); form.set("file", file);
        const result = await request(`/api/admin/evidence/${bundle.id}/files`, { method: "POST", body: form }) as { source: Source };
        uploaded.push(result.source);
      }
      const merged = [...(bundle.sources ?? [])];
      for (const source of uploaded) {
        const existing = merged.findIndex((item) => item.contentHash === source.contentHash);
        if (existing >= 0) merged[existing] = source; else merged.push(source);
      }
      updateBundle({ ...bundle, sources: merged });
      await loadBundle(bundle.id);
      setMessage(`${files.length}개 파일을 등록했습니다.`);
    } catch (value) { fail(value); } finally { setBusy(false); event.target.value = ""; }
  };

  const addSpatialJson = async (event: React.FormEvent) => {
    event.preventDefault(); if (!bundle) return; setBusy(true); setError("");
    try {
      const json = String(new FormData(event.currentTarget as HTMLFormElement).get("spatial-json") ?? "");
      parseSpatialEvidenceJson(json);
      const file = new File([json], `spatial-evidence-${Date.now()}.json`, { type: "application/json" });
      const form = new FormData(); form.set("file", file);
      const result = await request(`/api/admin/evidence/${bundle.id}/files`, { method: "POST", body: form }) as { source: Source };
      updateBundle({ ...bundle, sources: [...(bundle.sources ?? []).filter((item) => item.contentHash !== result.source.contentHash), result.source] });
      setSpatialJson(""); setMessage("JSON 근거를 등록했습니다.");
    } catch (value) { fail(value); } finally { setBusy(false); }
  };

  const addClip = async (event: React.FormEvent) => {
    event.preventDefault(); if (!bundle) return; setBusy(true); setError("");
    try {
      const result = await request(`/api/admin/evidence/${bundle.id}/clips`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: clip.url, startMs: timecode(clip.start), endMs: timecode(clip.end), observation: clip.observation }) }) as { bundle: EvidenceWizardBundle };
      await loadBundle(result.bundle.id); setClip({ url: "", start: "00:00:00", end: "00:00:10", observation: "" }); setMessage("영상 구간을 등록했습니다.");
    } catch (value) { fail(value); } finally { setBusy(false); }
  };

  const startAnalysis = async () => {
    if (!bundle || !confirmation) return; setBusy(true); setError("");
    try {
      const result = await request(`/api/admin/evidence/${bundle.id}/analyze`, { method: "POST" }) as { job: Job };
      updateBundle({ ...bundle, latestJob: result.job, cards: [] }); setMessage("등록한 근거만으로 분석을 시작했습니다.");
    } catch (value) { fail(value); } finally { setBusy(false); }
  };

  const retryJob = async () => {
    if (!job || !bundle) return; setBusy(true);
    try { const result = await request(`/api/admin/evidence/jobs/${job.id}`, { method: "POST" }) as { job: Job }; updateBundle({ ...bundle, latestJob: result.job }); }
    catch (value) { fail(value); } finally { setBusy(false); }
  };

  const review = async (card: Card, status: "owner_reviewed" | "held" | "rejected") => {
    setBusy(true); setError("");
    try {
      const result = await request(`/api/admin/evidence/cards/${card.id}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, content: card.content, expectedUpdatedAt: card.updatedAt }) }) as { card: Card };
      updateBundle({ ...bundle!, cards: bundle!.cards!.map((item) => item.id === card.id ? { ...item, ...result.card } : item) }); setMessage(status === "owner_reviewed" ? "본인 검수를 기록했습니다." : "검수 상태를 저장했습니다.");
    } catch (value) { fail(value); } finally { setBusy(false); }
  };

  const inspectDelete = async (sourceId: string) => {
    if (!bundle) return;
    try {
      const result = await request(`/api/admin/evidence/${bundle.id}/files/${sourceId}/impact`) as { impact: { cardIds: string[]; scenarioDraftIds: string[] } };
      setImpact({ sourceId, cardCount: result.impact.cardIds.length, scenarioDraftCount: result.impact.scenarioDraftIds.length });
    } catch (value) { fail(value); }
  };
  const deleteSource = async () => {
    if (!bundle || !impact || impact.cardCount + impact.scenarioDraftCount > 0) return;
    setBusy(true);
    try { await request(`/api/admin/evidence/${bundle.id}/files/${impact.sourceId}`, { method: "DELETE" }); updateBundle({ ...bundle, sources: bundle.sources?.filter((item) => item.id !== impact.sourceId) }); setImpact(null); setMessage("근거 파일을 삭제했습니다."); }
    catch (value) { fail(value); } finally { setBusy(false); }
  };

  return <main className="evidence-admin-shell">
    <header className="evidence-admin-header"><div><span className="evidence-kicker">TACTIQ · COACH DESK</span><h1>근거로 만드는 전술 카드</h1><p>LLM은 초안을 정리하고, 최종 판단은 운영자와 코치가 직접 합니다.</p></div>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/">훈련 화면으로</a>
    </header>
    <nav className="evidence-steps" aria-label="근거 등록 단계">{steps.map((item) => <button key={item.id} className={step === item.id ? "is-current" : ""} aria-current={step === item.id ? "step" : undefined} onClick={() => setStep(item.id)}><span>{item.number}</span>{item.label}</button>)}</nav>
    <div className="evidence-layout">
      <aside className="bundle-rail"><div className="rail-title"><strong>근거 묶음</strong><button onClick={() => { setSelectedId(""); setStep("info"); }}>새로 만들기</button></div>{bundles.map((item) => <button key={item.id} className={selectedId === item.id ? "is-selected" : ""} onClick={() => { setSelectedId(item.id); setConfirmation(false); }}><strong>{item.title}</strong><small>v{item.version} · {item.purpose}</small></button>)}</aside>
      <section className="evidence-workspace">
        {(message || error) && <div aria-live="polite" role={error ? "alert" : undefined} className={error ? "evidence-alert error" : "evidence-alert"}>{error || message}</div>}
        {step === "info" && <form className="evidence-panel form-panel" onSubmit={createBundle}><span className="panel-number">01 · 자료 정보</span><h2>어떤 판단을 훈련할 자료인가요?</h2><label>묶음 이름<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 전방 압박에서 픽소의 선택" /></label><label>훈련 목적<textarea required value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="선수가 경기에서 개선해야 할 판단을 한 문장으로 적어주세요." /></label><div className="guideline"><strong>좋은 근거 묶음</strong><ul><li>하나의 전술 원칙과 하나의 학습 목표에 집중합니다.</li><li>원문, 페이지 또는 영상 시간대를 확인할 수 있어야 합니다.</li><li>서로 다른 코치 의견은 지우지 않고 충돌로 남깁니다.</li></ul></div><button className="evidence-primary" disabled={busy}>묶음 만들고 근거 추가</button></form>}
        {step === "sources" && <div className="evidence-panel"><span className="panel-number">02 · 근거 추가</span><h2>원문과 관찰을 함께 등록하세요</h2>{!bundle ? <p>먼저 자료 정보에서 근거 묶음을 만들어 주세요.</p> : <><div className="upload-drop"><input id="evidence-files" type="file" multiple accept=".pdf,.txt,.md,.markdown,.json,application/pdf,application/json,text/plain,text/markdown" onChange={upload} disabled={busy}/><label htmlFor="evidence-files"><strong>PDF · TXT · Markdown · JSON 업로드</strong><span>파일당 최대 20MB · JSON은 공간 전술 표준 형식만 허용</span></label></div><form className="clip-form json-form" onSubmit={addSpatialJson}><h3>공간 전술 JSON 붙여넣기</h3><p>선수 좌표, 수비 형태, 판단 단서와 행동 경로를 포함한 표준 JSON을 검사한 뒤 저장합니다.</p><label>JSON 원문<textarea name="spatial-json" required value={spatialJson} onChange={(event) => setSpatialJson(event.target.value)} placeholder={'{\n  "source": { ... },\n  "coordinateSystem": { ... },\n  "scene": { ... }\n}'}/></label><button disabled={busy || !spatialJson.trim()}>JSON 근거 저장</button></form><div className="source-list">{(bundle.sources ?? []).map((source) => <article key={source.id}><div><strong>{source.originalFileName}</strong><small>{Math.ceil(source.byteSize / 1024)}KB · {source.extractionStatus === "completed" ? "텍스트 준비됨" : "원문 보관 · OCR 필요"}</small></div><a href={`/api/admin/evidence/${bundle.id}/files/${source.id}`}>원문</a><button onClick={() => void inspectDelete(source.id)}>삭제</button></article>)}</div><form className="clip-form" onSubmit={addClip}><h3>영상 구간 직접 기록</h3><label>HTTPS 영상 URL<input required type="url" value={clip.url} onChange={(event) => setClip({ ...clip, url: event.target.value })}/></label><div><label>시작<input required value={clip.start} onChange={(event) => setClip({ ...clip, start: event.target.value })}/></label><label>종료<input required value={clip.end} onChange={(event) => setClip({ ...clip, end: event.target.value })}/></label></div><label>이 구간에서 확인한 사실<textarea required value={clip.observation} onChange={(event) => setClip({ ...clip, observation: event.target.value })}/></label><button disabled={busy}>영상 구간 추가</button></form><button className="evidence-primary" disabled={!inventoryReady} onClick={() => setStep("analysis")}>등록 자료 확인하기</button></>}</div>}
        {step === "analysis" && <div className="evidence-panel"><span className="panel-number">03 · 분석 확인</span><h2>분석 범위를 마지막으로 확인하세요</h2>{!bundle ? <p>선택한 근거 묶음이 없습니다.</p> : <><div className="inventory"><strong>{bundle.title}</strong><span>문서 {bundle.sources?.length ?? 0}개 · 영상 {bundle.videoClips?.length ?? 0}개</span>{(bundle.sources ?? []).map((source) => <p key={source.id}>문서 · {source.originalFileName}</p>)}{(bundle.videoClips ?? []).map((item, index) => <p key={item.id ?? index}>영상 · {item.url} · {item.observation}</p>)}</div><label className="confirm-row"><input aria-label="등록한 자료만 분석한다는 점을 확인했습니다" name="analysis-confirmation" type="checkbox" checked={confirmation} onChange={(event) => setConfirmation(event.target.checked)}/><span><strong>등록한 자료만 분석한다는 점을 확인했습니다</strong><small>인터넷 지식이나 출처 없는 전술 설명은 정답으로 사용하지 않습니다.</small></span></label><button className="evidence-primary" disabled={!inventoryReady || !confirmation || busy || job?.status === "running" || job?.status === "queued"} onClick={() => void startAnalysis()}>분석 시작</button>{job && <div className={`job-status ${job.status}`} aria-live="polite"><strong>{job.status === "review_ready" ? "카드 검수 준비 완료" : job.status === "failed" ? "분석 중단" : "근거 분석 중"}</strong><span>단계: {job.stage} · 시도 {job.attemptCount}회</span>{job.isStale && <p role="alert">자료가 변경되어 이 분석은 오래된 버전입니다.</p>}{job.status === "failed" && <button onClick={() => void retryJob()}>분석 다시 시도</button>}{job.status === "review_ready" && <button onClick={() => setStep("review")}>카드 검수로 이동</button>}</div>}</>}</div>}
        {step === "review" && <div className="evidence-panel review-panel"><span className="panel-number">04 · 카드 검수</span><h2>근거와 설명을 나란히 확인하세요</h2>{!bundle?.cards?.length ? <p className="empty-review">분석이 완료되면 검수할 카드가 여기에 표시됩니다.</p> : bundle.cards.map((card) => <article className="review-card" key={card.id}><header><div><span>{defenseLabels[card.content.defenseType] ?? card.content.defenseType}</span><h3>{card.content.situation}</h3></div><em>{card.content.confidence === "high" ? "높은 확신" : card.content.confidence === "medium" ? "중간 확신" : "낮은 확신"}</em></header><div className="review-columns"><section aria-label="출처 근거"><h4>코치 원문 근거</h4>{card.citations.map((citation) => <button key={citation.chunkId} ref={(node) => { if (node) citationRefs.current.set(citation.chunkId, node); }} className="citation-excerpt" id={`citation-${citation.chunkId}`}><strong>근거 {citationLabel(citation.chunkId)} · {citation.locationLabel}</strong><span>{citation.excerpt}</span></button>)}</section><section aria-label="전술 카드 설명"><h4>선수에게 보여줄 설명</h4><dl><dt>조건</dt><dd>{card.content.conditions.join(" · ") || "없음"}</dd><dt>관찰 단서</dt><dd>{card.content.cues.join(" · ") || "없음"}</dd></dl>{(["preferred", "alternatives", "risky"] as const).map((group) => card.content[group].map((item, index) => <div className={`action-reason ${group}`} key={`${group}-${index}`}><strong>{actionLabels[item.action]}{item.tacticalIntent ? ` · ${intentLabels[item.tacticalIntent] ?? item.tacticalIntent}` : ""} {group === "preferred" ? "권장 이유" : group === "alternatives" ? "대안 이유" : "주의 이유"}</strong>{item.actorId && <small>{item.actorId}{item.targetId ? ` → ${item.targetId}` : ""}{item.trigger ? ` · 조건: ${item.trigger}` : ""}</small>}<p>{item.reason}</p><div>{item.citationIds.map((id) => <button key={id} onClick={() => citationRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" })}>근거 {citationLabel(id)}</button>)}</div></div>))}</section></div><div className="animation-memory"><strong>직관적 애니메이션 설명</strong><ol><li><span>관찰</span>수비 위치와 열린 공간을 본다</li><li><span>선택</span>신체 행동과 전술 의도를 함께 확인한다</li><li><span>결과</span>경로·대상·발동 조건이 어떻게 연결되는지 본다</li><li><span>기억</span>경기에서 확인할 한 문장으로 남긴다</li></ol></div>{card.content.conflicts.length > 0 && <p role="alert" className="conflict">미해결 충돌: {card.content.conflicts.join(" · ")}</p>}<footer><button onClick={() => void review(card, "rejected")}>반려</button><button onClick={() => void review(card, "held")}>보류</button><button className="approve" disabled={!cardReady(card) || busy} onClick={() => void review(card, "owner_reviewed")}>본인 검수 완료</button></footer></article>)}</div>}
      </section>
    </div>
    {impact && <div className="evidence-dialog-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="delete-title" className="evidence-dialog"><h2 id="delete-title">근거 삭제 영향 확인</h2><p>연결된 카드 {impact.cardCount}개 · 시나리오 초안 {impact.scenarioDraftCount}개</p>{impact.cardCount + impact.scenarioDraftCount > 0 && <p role="alert">연결된 검수 기록이 있어 삭제할 수 없습니다.</p>}<div><button onClick={() => setImpact(null)}>취소</button><button className="danger" disabled={busy || impact.cardCount + impact.scenarioDraftCount > 0} onClick={() => void deleteSource()}>삭제 확인</button></div></div></div>}
  </main>;
}
