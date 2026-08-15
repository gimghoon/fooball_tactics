"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AttemptInput, PublicScenarioProjection } from "@/lib/domain/content";
import { TacticalPitch, type TacticalChoice } from "./TacticalPitch";

type Scenario = { id: string; role: "fixo" | "ala" | "pivo" | "recap"; principle: string; prompt: string; contentJson: string; orderIndex: number };
type Auth = { participantId: string; recoveryToken: string };
type Feedback = { correct: boolean; hint: string | null; explanation: string | null };

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
  const scenario = scenarios[index];
  const roleName = { fixo: "픽소", ala: "알라", pivo: "피보", recap: "전체 움직임" }[scenario?.role ?? "fixo"];

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
      setFeedback(await response.json() as Feedback);
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
  return (
    <main className="training-screen">
      <header className="training-nav"><Link href="/">←</Link><div><span>{campaign.title}</span><strong>{index + 1} / {scenarios.length}</strong></div></header>
      <section className="scenario-copy"><span>{roleName} · {scenario.principle}</span><h1>{scenario.prompt}</h1></section>
      <TacticalPitch key={scenario.id} content={content} disabled={saving} onSubmit={(choice) => { void submit(choice); }} />
      {feedback ? <section className={feedback.correct ? "feedback correct" : "feedback"}><strong>{feedback.correct ? "좋은 선택이에요" : feedback.explanation ? "정답 움직임을 확인하세요" : "한 번 더 생각해볼까요?"}</strong><p>{feedback.explanation ?? feedback.hint}</p>{feedback.correct && index < scenarios.length - 1 ? <button className="primary-button" onClick={() => { setIndex(index + 1); setFeedback(null); }}>다음 포지션 →</button> : null}{feedback.correct && index === scenarios.length - 1 ? <div className="reflection-box"><strong>다음 경기 미션</strong><p>공을 받기 전 동료와 상대를 한 번씩 확인하세요. 경기 후 어땠는지 남겨주세요.</p>{reflectionSaved ? <span>회고를 저장했어요 ✓</span> : <div><button onClick={() => void reflect("worked")}>잘 됨</button><button onClick={() => void reflect("difficult")}>어려웠음</button></div>}</div> : null}</section> : null}
    </main>
  );
}
