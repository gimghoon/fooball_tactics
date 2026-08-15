"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { HighlightRef, PitchState, Point, ScenarioTimeline } from "@/lib/domain/content";
import { frameAt, snapToKeyframe } from "@/lib/domain/timeline";

type ScenarioPlaybackProps = {
  pitch: PitchState;
  timeline: ScenarioTimeline;
  selectedPath: Point[] | null;
  recommendedPath: Point[] | null;
  highlights: HighlightRef[];
  currentMs: number;
  playing: boolean;
  generation: number;
  onCurrentMsChange: (atMs: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onRestart: () => void;
  onPlaybackComplete: () => void;
  prefersReducedMotion?: boolean;
};

function pathPoints(path: Point[]): string {
  return path.map(({ x, y }) => `${x},${y}`).join(" ");
}

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

export function ScenarioPlayback({
  pitch,
  timeline,
  selectedPath,
  recommendedPath,
  highlights,
  currentMs,
  playing,
  generation,
  onCurrentMsChange,
  onPlayingChange,
  onRestart,
  onPlaybackComplete,
  prefersReducedMotion,
}: ScenarioPlaybackProps) {
  const systemReducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    serverReducedMotionSnapshot,
  );
  const reducedMotion = prefersReducedMotion ?? systemReducedMotion;
  const currentMsRef = useRef(currentMs);

  useEffect(() => {
    currentMsRef.current = currentMs;
  }, [currentMs]);

  useEffect(() => {
    if (!playing || reducedMotion === null) return;
    if (reducedMotion) {
      onCurrentMsChange(snapToKeyframe(timeline, timeline.durationMs));
      onPlayingChange(false);
      onPlaybackComplete();
      return;
    }

    const startMs = currentMsRef.current >= timeline.durationMs ? 0 : currentMsRef.current;
    let origin: number | null = null;
    let requestId = 0;
    const tick = (timestamp: number) => {
      origin ??= timestamp;
      const nextMs = Math.min(startMs + timestamp - origin, timeline.durationMs);
      onCurrentMsChange(nextMs);
      if (nextMs < timeline.durationMs) {
        requestId = window.requestAnimationFrame(tick);
      } else {
        onPlayingChange(false);
        onPlaybackComplete();
      }
    };
    requestId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(requestId);
  }, [generation, onCurrentMsChange, onPlaybackComplete, onPlayingChange, playing, reducedMotion, timeline, timeline.durationMs]);

  const endpointOnly = reducedMotion !== false;
  const displayedMs = endpointOnly ? snapToKeyframe(timeline, currentMs) : currentMs;
  const frame = useMemo(() => frameAt(timeline, displayedMs), [displayedMs, timeline]);
  const highlighted = useMemo(
    () => new Set(highlights.map((highlight) => `${highlight.kind}:${highlight.id}`)),
    [highlights],
  );
  const players = pitch.players.map((player) => ({ ...player, ...(frame.players[player.id] ?? {}) }));

  function replay() {
    onRestart();
  }

  function seek(atMs: number) {
    onPlayingChange(false);
    onCurrentMsChange(endpointOnly ? snapToKeyframe(timeline, atMs) : atMs);
  }

  const showArrows = reducedMotion !== false;
  const selectedEndpoint = selectedPath?.at(-1);
  const recommendedEndpoint = recommendedPath?.at(-1);
  return (
    <section className="scenario-playback" aria-label="검수된 움직임 다시 보기">
      <svg className="live-pitch playback-pitch" viewBox="0 0 100 100" aria-label="검수된 전술 움직임">
        <defs>
          <marker id="selected-arrow" className="reduced-motion-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
          <marker id="recommended-arrow" className="reduced-motion-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <rect x="4" y="4" width="92" height="92" rx="3" className="pitch-line" />
        <line x1="4" x2="96" y1="50" y2="50" className="pitch-line" />
        <circle cx="50" cy="50" r="12" className="pitch-line" />
        {pitch.zones.map(({ id, zone }) => (
          <circle
            key={id}
            cx={zone.cx}
            cy={zone.cy}
            r={zone.radius}
            className={`playback-zone${highlighted.has(`zone:${id}`) ? " is-highlighted" : ""}`}
          />
        ))}
        {selectedPath && selectedPath.length > 1 ? (
          <polyline
            points={pathPoints(selectedPath)}
            className={`selected-playback-path${highlighted.has("path:selected-path") ? " is-highlighted" : ""}`}
            markerEnd={showArrows ? "url(#selected-arrow)" : undefined}
          />
        ) : null}
        {recommendedPath && recommendedPath.length > 1 ? (
          <polyline
            points={pathPoints(recommendedPath)}
            className={`recommended-playback-path${highlighted.has("path:recommended-path") ? " is-highlighted" : ""}`}
            markerEnd={showArrows ? "url(#recommended-arrow)" : undefined}
          />
        ) : null}
        {showArrows && selectedEndpoint ? <circle cx={selectedEndpoint.x} cy={selectedEndpoint.y} r="2.4" className="path-endpoint selected-path-endpoint" /> : null}
        {showArrows && recommendedEndpoint ? <circle cx={recommendedEndpoint.x} cy={recommendedEndpoint.y} r="2.4" className="path-endpoint recommended-path-endpoint" /> : null}
        {players.map((player) => (
          <g key={player.id} className={highlighted.has(`player:${player.id}`) ? "playback-player-highlight" : undefined}>
            <title>{player.id}</title>
            <circle cx={player.x} cy={player.y} r="5" className={player.team === "us" ? "player" : "opponent"} />
          </g>
        ))}
        <circle cx={frame.ball.x} cy={frame.ball.y} r="2.3" className="ball" />
      </svg>
      <div className="playback-controls">
        <button type="button" onClick={replay}>다시 보기</button>
        <button type="button" onClick={() => onPlayingChange(!playing)} disabled={reducedMotion !== false}>
          {playing ? "일시정지" : "재생"}
        </button>
        <label>
          <span>재생 위치</span>
          <input
            className={`playback-seek${endpointOnly ? " playback-keyframe-seek" : ""}`}
            type="range"
            min="0"
            max={timeline.durationMs}
            step="10"
            value={displayedMs}
            onChange={(event) => seek(Number(event.currentTarget.value))}
          />
        </label>
      </div>
    </section>
  );
}
