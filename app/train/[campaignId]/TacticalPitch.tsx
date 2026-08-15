"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { normalizeClientPoint } from "@/lib/domain/geometry";
import type { ActionType, HighlightRef, Point, PublicScenarioProjection } from "@/lib/domain/content";
import { frameAt } from "@/lib/domain/timeline";
import { classifyPlayerTap, defenseTypeLabel, playerAriaLabel } from "@/lib/domain/tactical-pitch";

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
  highlights?: HighlightRef[];
  observeText?: string | null;
  selectedPath?: Point[] | null;
  prefersReducedMotion?: boolean;
  onSubmit: (input: TacticalChoice) => void;
};

function subscribeToReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function reducedMotionSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function serverReducedMotionSnapshot(): null {
  return null;
}

function pathPoints(path: Point[]): string {
  return path.map(({ x, y }) => `${x},${y}`).join(" ");
}

export function TacticalPitch({
  content,
  disabled = false,
  highlights = [],
  observeText = null,
  selectedPath = null,
  prefersReducedMotion,
  onSubmit,
}: TacticalPitchProps) {
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null);
  const [cursor, setCursor] = useState<Point>({ x: 50, y: 50 });
  const [setupMs, setSetupMs] = useState(0);
  const [setupPlaying, setSetupPlaying] = useState(content.setupTimeline.durationMs > 0);
  const [setupGeneration, setSetupGeneration] = useState(0);
  const setupMsRef = useRef(setupMs);
  const systemReducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    serverReducedMotionSnapshot,
  );
  const reducedMotion = prefersReducedMotion ?? systemReducedMotion;
  const setupLocked = reducedMotion === null || (reducedMotion === false && setupPlaying);

  useEffect(() => {
    setupMsRef.current = setupMs;
  }, [setupMs]);

  useEffect(() => {
    if (reducedMotion !== false || !setupPlaying || content.setupTimeline.durationMs === 0) return;
    const startMs = setupMsRef.current >= content.setupTimeline.durationMs ? 0 : setupMsRef.current;
    let origin: number | null = null;
    let requestId = 0;
    const tick = (timestamp: number) => {
      origin ??= timestamp;
      const nextMs = Math.min(startMs + timestamp - origin, content.setupTimeline.durationMs);
      setSetupMs(nextMs);
      if (nextMs < content.setupTimeline.durationMs) {
        requestId = window.requestAnimationFrame(tick);
      } else {
        setSetupPlaying(false);
      }
    };
    requestId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(requestId);
  }, [content.setupTimeline, reducedMotion, setupGeneration, setupPlaying]);

  const displayedMs = reducedMotion ? content.setupTimeline.durationMs : setupMs;
  const frame = useMemo(
    () => frameAt(content.setupTimeline, displayedMs),
    [content.setupTimeline, displayedMs],
  );
  const setupStart = useMemo(() => frameAt(content.setupTimeline, 0), [content.setupTimeline]);
  const setupEnd = useMemo(
    () => frameAt(content.setupTimeline, content.setupTimeline.durationMs),
    [content.setupTimeline],
  );
  const highlighted = useMemo(
    () => new Set(highlights.map((highlight) => `${highlight.kind}:${highlight.id}`)),
    [highlights],
  );
  const players = content.pitch.players.map((player) => ({
    ...player,
    ...(frame.players[player.id] ?? {}),
  }));
  const actor = players.find((player) => player.id === content.actorId);
  const ball = frame.ball;
  const destinationControls = selectedAction === "dribble"
    || selectedAction === "move"
    || (selectedAction === "pass" && content.passInputMode === "destination");
  const setupMotions = content.pitch.players.flatMap((player) => {
    const from = setupStart.players[player.id] ?? player;
    const to = setupEnd.players[player.id] ?? player;
    return from.x === to.x && from.y === to.y ? [] : [{ id: player.id, from, to }];
  });

  function submitDestination(event: PointerEvent<SVGSVGElement>) {
    if (!selectedAction || disabled || setupLocked) return;
    if (selectedAction === "pass" && content.passInputMode === "player") return;
    const destination = normalizeClientPoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
    );
    onSubmit({ actionType: selectedAction, destination });
  }

  function submitPassPlayer(player: typeof players[number]) {
    if (disabled || setupLocked) return;
    if (content.passInputMode === "destination") {
      onSubmit({ actionType: "pass", destination: { x: player.x, y: player.y } });
    } else {
      onSubmit({ actionType: "pass", targetPlayerId: player.id });
    }
  }

  function submitPlayer(event: PointerEvent<SVGGElement>, player: typeof players[number]) {
    const outcome = classifyPlayerTap(selectedAction, actor, player);
    if (outcome === "pass-target") {
      event.stopPropagation();
      submitPassPlayer(player);
    } else if (outcome === "ignore") {
      event.stopPropagation();
    }
  }

  function submitPlayerByKeyboard(event: KeyboardEvent<SVGGElement>, player: typeof players[number]) {
    if (classifyPlayerTap(selectedAction, actor, player) !== "pass-target") return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      submitPassPlayer(player);
    }
  }

  function replaySetup() {
    if (content.setupTimeline.durationMs === 0) return;
    setSetupMs(0);
    setSetupPlaying(true);
    setSetupGeneration((generation) => generation + 1);
  }

  function submitCursor() {
    if (!selectedAction || !destinationControls || disabled || setupLocked) return;
    onSubmit({ actionType: selectedAction, destination: cursor });
  }

  return (
    <section aria-label="전술 행동 선택">
      {content.defenseType ? <p className="defense-type-label">수비 상황 · {defenseTypeLabel(content.defenseType)}</p> : null}
      <div className="action-picker" aria-label="행동 선택">
        {content.allowedActions.map((action) => (
          <button
            key={action}
            type="button"
            className="action-button"
            aria-pressed={selectedAction === action}
            disabled={disabled || setupLocked}
            onClick={() => setSelectedAction(action)}
          >
            {ACTION_LABELS[action]}
          </button>
        ))}
      </div>
      <div className="setup-status">
        <p className="pitch-instruction">{setupLocked ? "수비 움직임을 먼저 보세요" : "행동을 먼저 고르세요"}</p>
        {content.setupTimeline.durationMs > 0 ? <button type="button" onClick={replaySetup}>상황 다시 보기</button> : null}
      </div>
      {observeText ? <p className="observe-clue">{observeText}</p> : null}
      <svg
        className="live-pitch"
        viewBox="0 0 100 100"
        aria-label="전술 경기장"
        onPointerDown={submitDestination}
      >
        <defs>
          <marker id="setup-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <rect x="4" y="4" width="92" height="92" rx="3" className="pitch-line" />
        <line x1="4" x2="96" y1="50" y2="50" className="pitch-line" />
        <circle cx="50" cy="50" r="12" className="pitch-line" />
        {reducedMotion && content.setupTimeline.durationMs > 0 ? setupMotions.map(({ id, from, to }) => (
          <g key={`setup-motion-${id}`}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="setup-motion-arrow" markerEnd="url(#setup-arrow)" />
            <circle cx={from.x} cy={from.y} r="2" className="setup-start-endpoint" />
            <circle cx={to.x} cy={to.y} r="2" className="setup-end-endpoint" />
          </g>
        )) : null}
        {content.pitch.zones.map(({ id, zone }) => (
          <circle
            key={id}
            cx={zone.cx}
            cy={zone.cy}
            r={zone.radius}
            className={highlighted.has(`zone:${id}`) ? "setup-zone-highlight" : "playback-zone"}
          />
        ))}
        {selectedPath && selectedPath.length > 1 ? (
          <polyline
            points={pathPoints(selectedPath)}
            className={`selected-path${highlighted.has("path:selected-path") ? " is-highlighted" : ""}`}
          />
        ) : null}
        {players.map((player) => {
          const selectable = classifyPlayerTap(selectedAction, actor, player) === "pass-target";
          return (
            <g
              key={player.id}
              data-player-id={player.id}
              role={selectable ? "button" : "img"}
              tabIndex={selectable ? 0 : undefined}
              aria-label={playerAriaLabel(actor, player)}
              className={highlighted.has(`player:${player.id}`) ? "setup-player-highlight" : undefined}
              onKeyDown={(event) => submitPlayerByKeyboard(event, player)}
              onPointerDown={(event) => submitPlayer(event, player)}
            >
              <title>{playerAriaLabel(actor, player)}</title>
              <circle data-player-id={player.id} cx={player.x} cy={player.y} r="5" className={player.team === "us" ? "player" : "opponent"} />
            </g>
          );
        })}
        <circle cx={ball.x} cy={ball.y} r="2.3" className="ball" />
      </svg>
      {destinationControls ? (
        <fieldset className="destination-cursor" disabled={disabled || setupLocked}>
          <legend>도착 좌표 선택</legend>
          <label>
            <span>X {cursor.x}</span>
            <input
              type="range"
              min="0"
              max="100"
              value={cursor.x}
              aria-label="도착 X 좌표"
              onChange={(event) => setCursor((point) => ({ ...point, x: Number(event.currentTarget.value) }))}
            />
          </label>
          <label>
            <span>Y {cursor.y}</span>
            <input
              type="range"
              min="0"
              max="100"
              value={cursor.y}
              aria-label="도착 Y 좌표"
              onChange={(event) => setCursor((point) => ({ ...point, y: Number(event.currentTarget.value) }))}
            />
          </label>
          <button type="button" onClick={submitCursor}>좌표로 제출</button>
        </fieldset>
      ) : null}
    </section>
  );
}
