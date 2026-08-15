import type { ActionType, PitchPlayer } from "./content.ts";

export type PlayerTapOutcome = "pass-target" | "destination" | "ignore";

export function classifyPlayerTap(
  actionType: ActionType | null,
  actor: PitchPlayer | undefined,
  player: PitchPlayer,
): PlayerTapOutcome {
  if (!actionType) return "ignore";
  if (actionType !== "pass") return "destination";
  return actor !== undefined && player.id !== actor.id && player.team === actor.team ? "pass-target" : "ignore";
}

export function playerAriaLabel(actor: PitchPlayer | undefined, player: PitchPlayer) {
  if (player.id === actor?.id) return `행동 선수 ${player.id}`;
  return `${player.team === actor?.team ? "동료" : "상대"} 선수 ${player.id}`;
}
