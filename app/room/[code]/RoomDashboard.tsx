"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Progress = { members: { id: string; nickname: string; completedStage: string }[]; teamMastery: Record<string, number> };
const labels: Record<string, string> = { width: "폭 유지", support: "삼각형 지원", pivot: "피보 연결", transition: "공수 전환" };

export function RoomDashboard({ code }: { code: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadProgress() {
      const session = JSON.parse(localStorage.getItem("tactiq-session") ?? "null") as { participantId?: string; recoveryToken?: string } | null;
      if (!session?.participantId || !session.recoveryToken) { await Promise.resolve(); setError("이 기기에서 팀방 복귀 키를 찾지 못했어요."); return; }
      const response = await fetch(`/api/rooms/${code}/progress`, { headers: { authorization: `Bearer ${session.recoveryToken}`, "x-participant-id": session.participantId } });
      const data = await response.json() as Progress & { error?: string };
      if (!response.ok) throw new Error(data.error);
      setProgress(data);
    }
    void loadProgress().catch((reason: Error) => setError(reason.message));
  }, [code]);

  const share = typeof window === "undefined" ? "" : `${window.location.origin}/?room=${code}`;
  return <main className="room-screen"><header className="training-nav"><Link href="/">←</Link><div><span>우리 팀 전술방</span><strong>{code}</strong></div></header><section className="room-hero"><span>초대 코드</span><h1>{code}</h1><p>{share || "초대 링크를 준비하고 있어요."}</p></section>{error ? <section className="feedback"><strong>팀방을 불러오지 못했어요</strong><p>{error}</p></section> : null}{progress ? <><section className="dashboard-card"><h2>팀원 진행</h2>{progress.members.map((member) => <div className="member-row" key={member.id}><span className="avatar">{member.nickname.slice(0, 1)}</span><strong>{member.nickname}</strong><small>{member.completedStage}</small></div>)}</section><section className="dashboard-card"><h2>팀 숙련도</h2>{Object.entries(progress.teamMastery).map(([principle, score]) => <div className="mastery-row" key={principle}><div><span>{labels[principle] ?? principle}</span><strong>{score}%</strong></div><div className="mastery-track"><i style={{ width: `${score}%` }} /></div></div>)}</section></> : !error ? <p className="loading-copy">팀 진도를 불러오는 중…</p> : null}</main>;
}
