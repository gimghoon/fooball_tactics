"use client";

import { useMemo, useState, type PointerEvent } from "react";
import { normalizeClientPoint } from "@/lib/domain/geometry";
import type { ActionType, Point, PublicScenarioProjection } from "@/lib/domain/content";
import { classifyPlayerTap, playerAriaLabel } from "@/lib/domain/tactical-pitch";

const ACTION_LABELS: Record<ActionType, string> = {
  pass: "패스",
  dribble: "드리블",
  move: "이동",
};

export type TacticalChoice = {
  actionType: ActionType;
  targetPlayerId?: string;
  destination?: Point;
};

type TacticalPitchProps = {
  content: PublicScenarioProjection;
  disabled?: boolean;
  onSubmit: (input: TacticalChoice) => void;
};

export function TacticalPitch({ content, disabled = false, onSubmit }: TacticalPitchProps) {
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null);
  const setup = useMemo(() => content.setupTimeline.keyframes.at(-1), [content]);
  const players = content.pitch.players.map((player) => ({
    ...player,
    ...(setup?.players[player.id] ?? {}),
  }));
  const actor = players.find((player) => player.id === content.actorId);
  const ball = setup?.ball ?? content.pitch.ball;

  function submitDestination(event: PointerEvent<SVGSVGElement>) {
    if (!selectedAction || disabled) return;
    const destination = normalizeClientPoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
    );
    onSubmit({ actionType: selectedAction, destination });
  }

  function submitPlayer(event: PointerEvent<SVGGElement>, player: typeof players[number]) {
    const outcome = classifyPlayerTap(selectedAction, actor, player);
    if (outcome === "pass-target") {
      event.stopPropagation();
      if (!disabled) onSubmit({ actionType: "pass", targetPlayerId: player.id });
    } else if (outcome === "ignore") {
      event.stopPropagation();
    }
  }

  return (
    <section aria-label="전술 행동 선택">
      <div className="action-picker" aria-label="행동 선택">
        {content.allowedActions.map((action) => (
          <button
            key={action}
            type="button"
            className="action-button"
            aria-pressed={selectedAction === action}
            disabled={disabled}
            onClick={() => setSelectedAction(action)}
          >
            {ACTION_LABELS[action]}
          </button>
        ))}
      </div>
      <p className="pitch-instruction">행동을 먼저 고르세요</p>
      <svg
        className="live-pitch"
        viewBox="0 0 100 100"
        aria-label="전술 경기장"
        onPointerDown={submitDestination}
      >
        <rect x="4" y="4" width="92" height="92" rx="3" className="pitch-line" />
        <line x1="4" x2="96" y1="50" y2="50" className="pitch-line" />
        <circle cx="50" cy="50" r="12" className="pitch-line" />
        {players.map((player) => (
          <g key={player.id} onPointerDown={(event) => submitPlayer(event, player)}>
            <title>{playerAriaLabel(actor, player)}</title>
            <circle cx={player.x} cy={player.y} r="5" className={player.team === "us" ? "player" : "opponent"} />
          </g>
        ))}
        <circle cx={ball.x} cy={ball.y} r="2.3" className="ball" />
      </svg>
    </section>
  );
}
