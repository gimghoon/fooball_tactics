"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AttemptInput, CoachExplanation, HighlightRef, Point, PublicScenarioProjection, ScenarioTimeline } from "@/lib/domain/content";
import {
  beginInitialPlayback,
  completePlayback,
  initialExplanationIndex,
  restartPlayback,
  type PlaybackReviewState,
} from "@/lib/domain/timeline";
import { CoachExplanationPanel } from "./CoachExplanationPanel";
import { ScenarioPlayback } from "./ScenarioPlayback";
import { TacticalPitch, type TacticalChoice } from "./TacticalPitch";

type Scenario = { id: string; role: "fixo" | "ala" | "pivo" | "recap"; principle: string; prompt: string; contentJson: string; orderIndex: number };
type Auth = { participantId: string; recoveryToken: string };
type Feedback = {
  correct: boolean;
  hint: string | null;
  explanation: string | null;
  selectedPath?: Point[] | null;
  recommendedPath?: Point[] | null;
  timeline?: ScenarioTimeline | null;
  explanations?: CoachExplanation[];
};

const INITIAL_PLAYBACK_STATE: PlaybackReviewState = {
  currentMs: 0,
  playing: false,
  generation: 0,
  initialPlaybackComplete: false,
};

function readAuth(): Auth | null {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(localStorage.getItem("tactiq-session") ?? "null") as Auth | null; } catch { return null; }
}

function readPendingAttempts(): AttemptInput[] {
  if (typeof window === "undefined") return [];
  try {
    const pending = JSON.parse(localStorage.getItem("tactiq-pending-attempts") ?? "[]");
    return Array.isArray(pending) ? pending as AttemptInput[] : [];
  } catch {
    return [];
  }
}

export function CampaignPlayer({ campaign, scenarios }: { campaign: { id: string; title: string }; scenarios: Scenario[] }) {
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [saving, setSaving] = useState(false);
  const [reflectionSaved, setReflectionSaved] = useState(false);
  const [playback, setPlayback] = useState<PlaybackReviewState>(INITIAL_PLAYBACK_STATE);
  const [highlights, setHighlights] = useState<HighlightRef[]>([]);
  const scenario = scenarios[index];
  const roleName = { fixo: "픽소", ala: "알라", pivo: "피보", recap: "전체 움직임" }[scenario?.role ?? "fixo"];
  const setPlaybackMs = useCallback((currentMs: number) => {
    setPlayback((state) => ({ ...state, currentMs }));
  }, []);
  const setPlaybackPlaying = useCallback((playing: boolean) => {
    setPlayback((state) => ({ ...state, playing }));
  }, []);
  const restartReviewedPlayback = useCallback(() => {
    setPlayback((state) => restartPlayback(state));
  }, []);
  const finishReviewedPlayback = useCallback(() => {
    setPlayback((state) => completePlayback(state));
  }, []);

  useEffect(() => {
    async function flushPending() {
      const auth = readAuth();
      const pending = readPendingAttempts();
      if (!auth || !pending.length) return;
      for (const event of pending) {
        const response = await fetch("/api/attempts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.recoveryToken}`, "x-participant-id": auth.participantId }, body: JSON.stringify(event) }).catch(() => null);
        if (response?.ok) {
          localStorage.setItem("tactiq-pending-attempts", JSON.stringify(readPendingAttempts().filter((item) => item.eventId !== event.eventId)));
        }
      }
    }
    void flushPending();
    window.addEventListener("online", flushPending);
    return () => window.removeEventListener("online", flushPending);
  }, []);

  async function submit(choice: TacticalChoice) {
    if (!scenario || saving) return;
    const auth = readAuth();
    if (!auth) { setFeedback({ correct: false, hint: "팀방 초대 링크로 입장한 뒤 훈련을 시작해주세요.", explanation: null }); return; }
    const event: AttemptInput = { eventId: crypto.randomUUID(), scenarioId: scenario.id, ...choice };
    setSaving(true);
    try {
      const response = await fetch("/api/attempts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.recoveryToken}`, "x-participant-id": auth.participantId }, body: JSON.stringify(event) });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error);
      const nextFeedback = await response.json() as Feedback;
      setFeedback(nextFeedback);
      if (nextFeedback.timeline && nextFeedback.explanations?.length) {
        const initialIndex = initialExplanationIndex(nextFeedback.explanations);
        setPlayback((state) => beginInitialPlayback(state));
        setHighlights(nextFeedback.explanations[initialIndex].highlights);
      }
    } catch (error) {
      const pending = readPendingAttempts();
      localStorage.setItem("tactiq-pending-attempts", JSON.stringify([...new Map([...pending, event].map((item) => [item.eventId, item])).values()]));
      setFeedback({ correct: false, hint: error instanceof Error ? `${error.message} 답안은 기기에 임시 저장했어요.` : "답안을 기기에 임시 저장했어요.", explanation: null });
    } finally { setSaving(false); }
  }

  async function reflect(result: "worked" | "difficult") {
    const auth = readAuth();
    if (!auth) return;
    const response = await fetch("/api/reflections", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.recoveryToken}`, "x-participant-id": auth.participantId }, body: JSON.stringify({ missionId: `${campaign.id}-first-touch`, result }) });
    setReflectionSaved(response.ok);
  }

  if (!scenario) return <main className="training-screen"><h1>검수된 문제가 아직 없어요.</h1></main>;
  const content = JSON.parse(scenario.contentJson) as PublicScenarioProjection;
  const reviewedTimeline = feedback?.timeline ?? null;
  const reviewedExplanations = feedback?.explanations ?? [];
  const reviewedPlayback = reviewedTimeline !== null && reviewedExplanations.length > 0;
  const reviewedPlaybackReady = reviewedPlayback && playback.initialPlaybackComplete;
  const canContinue = feedback !== null && (
    reviewedPlayback ? playback.initialPlaybackComplete : feedback.correct || feedback.explanation !== null
  );

  function nextScenario() {
    setIndex(index + 1);
    setFeedback(null);
    setPlayback(INITIAL_PLAYBACK_STATE);
    setHighlights([]);
  }

  return (
    <main className="training-screen">
      <header className="training-nav"><Link href="/">←</Link><div><span>{campaign.title}</span><strong>{index + 1} / {scenarios.length}</strong></div></header>
      <section className="scenario-copy"><span>{roleName} · {scenario.principle}</span><h1>{scenario.prompt}</h1></section>
      {reviewedPlayback ? (
        <ScenarioPlayback
          pitch={content.pitch}
          timeline={reviewedTimeline}
          selectedPath={feedback.selectedPath ?? null}
          recommendedPath={feedback.recommendedPath ?? null}
          highlights={highlights}
          currentMs={playback.currentMs}
          playing={playback.playing}
          generation={playback.generation}
          onCurrentMsChange={setPlaybackMs}
          onPlayingChange={setPlaybackPlaying}
          onRestart={restartReviewedPlayback}
          onPlaybackComplete={finishReviewedPlayback}
        />
      ) : (
        <TacticalPitch key={scenario.id} content={content} disabled={saving} onSubmit={(choice) => { void submit(choice); }} />
      )}
      {feedback ? (
        <section className={feedback.correct ? "feedback correct" : "feedback"}>
          <strong>{feedback.correct ? "좋은 선택이에요" : reviewedPlayback || feedback.explanation ? "정답 움직임을 확인하세요" : "한 번 더 생각해볼까요?"}</strong>
          {reviewedPlayback ? (
            reviewedPlaybackReady ? (
              <CoachExplanationPanel
                explanations={reviewedExplanations}
                onSeek={(atMs) => {
                  setPlayback((state) => ({ ...state, playing: false, currentMs: atMs }));
                }}
                onHighlightsChange={setHighlights}
              />
            ) : null
          ) : <p>{feedback.explanation ?? feedback.hint}</p>}
          {canContinue && index < scenarios.length - 1 ? <button className="primary-button" onClick={nextScenario}>다음 포지션 →</button> : null}
          {canContinue && index === scenarios.length - 1 ? <div className="reflection-box"><strong>다음 경기 미션</strong><p>공을 받기 전 동료와 상대를 한 번씩 확인하세요. 경기 후 어땠는지 남겨주세요.</p>{reflectionSaved ? <span>회고를 저장했어요 ✓</span> : <div><button onClick={() => void reflect("worked")}>잘 됨</button><button onClick={() => void reflect("difficult")}>어려웠음</button></div>}</div> : null}
        </section>
      ) : null}
    </main>
  );
}
