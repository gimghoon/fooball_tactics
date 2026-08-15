"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { normalizeClientPoint } from "@/lib/domain/geometry";

type Scenario = { id: string; role: "fixo" | "ala" | "pivo" | "recap"; principle: string; prompt: string; hint: string; explanation: string; pitchJson: string; orderIndex: number };
type Auth = { participantId: string; recoveryToken: string };
type Feedback = { correct: boolean; hint: string | null; explanation: string | null; answer: { cx: number; cy: number; radius: number } | null };

function readAuth(): Auth | null {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(localStorage.getItem("tactiq-session") ?? "null") as Auth | null; } catch { return null; }
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
      const pending = JSON.parse(localStorage.getItem("tactiq-pending-attempts") ?? "[]") as { eventId: string; scenarioId: string; x: number; y: number }[];
      if (!auth || !pending.length) return;
      const remaining = [...pending];
      for (const event of pending) {
        const response = await fetch("/api/attempts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.recoveryToken}`, "x-participant-id": auth.participantId }, body: JSON.stringify(event) }).catch(() => null);
        if (response?.ok) remaining.splice(remaining.findIndex((item) => item.eventId === event.eventId), 1);
      }
      localStorage.setItem("tactiq-pending-attempts", JSON.stringify(remaining));
    }
    void flushPending();
    window.addEventListener("online", flushPending);
    return () => window.removeEventListener("online", flushPending);
  }, []);

  async function submit(x: number, y: number) {
    if (!scenario || saving) return;
    const auth = readAuth();
    if (!auth) { setFeedback({ correct: false, hint: "팀방 초대 링크로 입장한 뒤 훈련을 시작해주세요.", explanation: null, answer: null }); return; }
    const event = { eventId: crypto.randomUUID(), scenarioId: scenario.id, x, y };
    setSaving(true);
    try {
      const response = await fetch("/api/attempts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.recoveryToken}`, "x-participant-id": auth.participantId }, body: JSON.stringify(event) });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error);
      setFeedback(await response.json() as Feedback);
    } catch (error) {
      const pending = JSON.parse(localStorage.getItem("tactiq-pending-attempts") ?? "[]") as typeof event[];
      localStorage.setItem("tactiq-pending-attempts", JSON.stringify([...new Map([...pending, event].map((item) => [item.eventId, item])).values()]));
      setFeedback({ correct: false, hint: error instanceof Error ? `${error.message} 답안은 기기에 임시 저장했어요.` : "답안을 기기에 임시 저장했어요.", explanation: null, answer: null });
    } finally { setSaving(false); }
  }

  async function reflect(result: "worked" | "difficult") {
    const auth = readAuth();
    if (!auth) return;
    const response = await fetch("/api/reflections", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.recoveryToken}`, "x-participant-id": auth.participantId }, body: JSON.stringify({ missionId: `${campaign.id}-first-touch`, result }) });
    setReflectionSaved(response.ok);
  }

  if (!scenario) return <main className="training-screen"><h1>검수된 문제가 아직 없어요.</h1></main>;
  const pitch = JSON.parse(scenario.pitchJson) as { players?: { x: number; y: number; team: "us" | "them" }[]; ball?: { x: number; y: number } };
  return (
    <main className="training-screen">
      <header className="training-nav"><Link href="/">←</Link><div><span>{campaign.title}</span><strong>{index + 1} / {scenarios.length}</strong></div></header>
      <section className="scenario-copy"><span>{roleName} · {scenario.principle}</span><h1>{scenario.prompt}</h1><p>좋다고 생각하는 공간이나 패스 대상을 직접 터치하세요.</p></section>
      <svg className="live-pitch" viewBox="0 0 100 100" onPointerDown={(event) => { const point = normalizeClientPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect()); void submit(point.x, point.y); }}>
        <rect x="1" y="1" width="98" height="98" rx="3" className="pitch-line" /><line x1="1" x2="99" y1="50" y2="50" className="pitch-line" /><circle cx="50" cy="50" r="12" className="pitch-line" />
        {pitch.players?.map((player, playerIndex) => <circle key={playerIndex} cx={player.x} cy={player.y} r="5" className={player.team === "us" ? "player" : "opponent"} />)}
        {pitch.ball ? <circle cx={pitch.ball.x} cy={pitch.ball.y} r="2.3" className="ball" /> : null}
        {feedback?.answer ? <circle cx={feedback.answer.cx} cy={feedback.answer.cy} r={feedback.answer.radius} className="target-zone" /> : null}
      </svg>
      {feedback ? <section className={feedback.correct ? "feedback correct" : "feedback"}><strong>{feedback.correct ? "좋은 선택이에요" : feedback.explanation ? "정답 움직임을 확인하세요" : "한 번 더 생각해볼까요?"}</strong><p>{feedback.explanation ?? feedback.hint}</p>{feedback.correct && index < scenarios.length - 1 ? <button className="primary-button" onClick={() => { setIndex(index + 1); setFeedback(null); }}>다음 포지션 →</button> : null}{feedback.correct && index === scenarios.length - 1 ? <div className="reflection-box"><strong>다음 경기 미션</strong><p>공을 받기 전 동료와 상대를 한 번씩 확인하세요. 경기 후 어땠는지 남겨주세요.</p>{reflectionSaved ? <span>회고를 저장했어요 ✓</span> : <div><button onClick={() => void reflect("worked")}>잘 됨</button><button onClick={() => void reflect("difficult")}>어려웠음</button></div>}</div> : null}</section> : null}
    </main>
  );
}
