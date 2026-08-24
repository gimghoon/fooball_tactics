"use client";

import { useEffect, useState } from "react";

const roles = [
  { name: "픽소", detail: "후방에서 각도 만들기", state: "준비" },
  { name: "알라", detail: "폭을 넓혀 패스길 열기", state: "다음" },
  { name: "피보", detail: "등지고 받아 연결하기", state: "다음" },
];

function PitchPreview() {
  const [touch, setTouch] = useState<{ x: number; y: number } | null>(null);

  return (
    <div className="pitch-wrap">
      <svg className="pitch" viewBox="0 0 100 136" role="img" aria-label="다이아몬드 전형을 보여주는 풋살 경기장 조작 데모"
        onPointerDown={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setTouch({ x: ((event.clientX - bounds.left) / bounds.width) * 100, y: ((event.clientY - bounds.top) / bounds.height) * 136 });
        }}>
        <rect x="1" y="1" width="98" height="134" rx="3" className="pitch-line" />
        <line x1="1" x2="99" y1="68" y2="68" className="pitch-line" />
        <circle cx="50" cy="68" r="12" className="pitch-line" />
        <path d="M30 1v13c0 10 40 10 40 0V1M30 135v-13c0-10 40-10 40 0v13" className="pitch-line" />
        <path d="M50 112 24 78 50 25 76 78Z" className="shape-line" />
        <circle cx="50" cy="112" r="5.5" className="player player-fixo" />
        <circle cx="24" cy="78" r="5.5" className="player" /><circle cx="76" cy="78" r="5.5" className="player" />
        <circle cx="50" cy="25" r="5.5" className="player" /><circle cx="31" cy="51" r="5" className="opponent" />
        <circle cx="68" cy="55" r="5" className="opponent" /><circle cx="50" cy="103" r="2.5" className="ball" />
        <circle cx="82" cy="103" r="10" className="target-zone" />
        {touch ? <circle cx={touch.x} cy={touch.y} r="3" className="touch-mark" /> : null}
      </svg>
      <div className="pitch-caption"><span className="pulse-dot" />조작 데모 · 이동할 공간을 터치해보세요</div>
    </div>
  );
}

export function FutsalApp({ initialInviteCode, showEvidenceAdmin }: { initialInviteCode: string | null; showEvidenceAdmin: boolean }) {
  const [showRoom, setShowRoom] = useState(Boolean(initialInviteCode));
  const [nickname, setNickname] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(initialInviteCode);
  const [roomMessage, setRoomMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/campaigns").then((response) => response.json()).then((data: { campaigns?: { id: string }[] }) => setCampaignId(data.campaigns?.[0]?.id ?? null)).catch(() => setCampaignId(null));
  }, []);

  async function enterRoom() {
    if (!nickname.trim() || (!inviteCode && !campaignId)) return;
    setBusy(true); setRoomMessage("");
    try {
      const response = await fetch(inviteCode ? `/api/rooms/${inviteCode}/join` : "/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inviteCode ? { nickname } : { nickname, campaignId }) });
      const result = await response.json() as { error?: string; participantId?: string; recoveryToken?: string; inviteCode?: string; roomId?: string };
      if (!response.ok) throw new Error(result.error ?? "팀방에 들어가지 못했어요.");
      localStorage.setItem("tactiq-session", JSON.stringify({ participantId: result.participantId, recoveryToken: result.recoveryToken, roomId: result.roomId, inviteCode: result.inviteCode ?? inviteCode }));
      const code = result.inviteCode ?? inviteCode;
      setInviteCode(code ?? null); setRoomMessage(code ? `팀방이 준비됐어요. 초대 코드 ${code}` : "팀방에 입장했어요.");
      if (code) window.location.assign(`/room/${code}`);
    } catch (error) { setRoomMessage(error instanceof Error ? error.message : "잠시 후 다시 시도해주세요."); }
    finally { setBusy(false); }
  }
  return (
    <main className="app-shell">
      <header className="topbar"><a className="brand" href="#top" aria-label="TACTIQ 홈"><span className="brand-mark">T</span><span>TACTIQ</span></a><div className="topbar-actions">{showEvidenceAdmin ? <a className="admin-link" href="/admin/evidence">코치 자료 관리</a> : null}<button className="icon-button" aria-label="도움말">?</button></div></header>
      <section className="hero" id="top"><div className="eyebrow"><span /> 오늘의 팀 훈련</div><h1>생각은 짧게.<br /><em>움직임은 함께.</em></h1><p>포지션을 바꿔가며 같은 장면을 풀고,<br />다음 경기에서 하나씩 실행해보세요.</p></section>
      <section className="training-card" aria-labelledby="campaign-title">
        <div className="card-topline"><span className="campaign-tag">입문 캠페인</span><span className="duration">약 10분</span></div>
        <h2 id="campaign-title">다이아몬드 1-2-1</h2><p className="card-copy">세 포지션의 시야로 패스 길을 만들고, 팀 전체의 모양을 연결합니다.</p>
        <PitchPreview />
        <div className="review-notice"><span aria-hidden="true">⌛</span><div><strong>코치 자료 검수 대기</strong><small>검수된 문제만 실제 훈련으로 공개됩니다.</small></div></div>
        <button className="primary-button" onClick={() => setShowRoom(true)}>팀방 만들기 <span>→</span></button>
        <button className="text-button" onClick={() => document.getElementById("roles")?.scrollIntoView({ behavior: "smooth" })}>훈련 방식 먼저 보기</button>
      </section>
      <section className="role-section" id="roles">
        <div className="section-heading"><span>01</span><h2>한 장면, 세 개의 시야</h2></div><p>모든 포지션을 돌아보며 내 움직임이 팀 동료에게 만드는 다음 선택을 배웁니다.</p>
        <div className="role-list">{roles.map((role, index) => <article className="role-row" key={role.name}><span className="role-number">0{index + 1}</span><div><h3>{role.name}</h3><p>{role.detail}</p></div><span className={index === 0 ? "status ready" : "status"}>{role.state}</span></article>)}</div>
      </section>
      <section className="mission-card"><span className="mission-label">경기장에서 이어하기</span><h2>오늘의 실전 미션</h2><p>공을 받기 전, 동료와 상대를 한 번씩 확인하고 몸의 방향을 열어두기.</p><div className="mission-actions"><span>경기 후 10초 회고</span><strong>잘 됨 · 어려웠음</strong></div></section>
      <footer><span>TACTIQ</span><p>같이 이해하고, 같이 움직이는 풋살.</p></footer>
      {showRoom ? <div className="sheet-backdrop"><section className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="room-title"><button className="sheet-close" onClick={() => setShowRoom(false)} aria-label="닫기">×</button><span className="sheet-kicker">팀 학습 시작하기</span><h2 id="room-title">{inviteCode ? "팀방에 합류하기" : "팀방을 만들 준비가 됐어요"}</h2><p>{campaignId || inviteCode ? "닉네임만 정하면 바로 시작할 수 있어요. 이 기기에 복귀 키가 안전하게 저장됩니다." : "코치 자료가 검수되면 초대 링크를 만들고 친구들의 포지션별 진도를 함께 확인할 수 있습니다."}</p><label>{inviteCode ? "내 닉네임" : "방장 닉네임"}<input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="예: 킥오프민수" maxLength={16} /></label><button className="primary-button" disabled={busy || !nickname.trim() || (!campaignId && !inviteCode)} onClick={() => void enterRoom()}>{busy ? "준비 중…" : inviteCode ? "팀방 입장하기" : campaignId ? "팀방 만들기" : "검수 후 팀방 열기"}</button>{roomMessage ? <p className="room-message" role="status">{roomMessage}</p> : null}<small>복귀 키를 잃으면 익명 진도를 복구할 수 없어요.</small></section></div> : null}
    </main>
  );
}
