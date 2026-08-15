import type { ActionType, DefenseType, PitchPlayer } from "./content.ts";

const DEFENSE_LABELS: Record<DefenseType, string> = {
  front_press: "전방 압박",
  central_block: "중앙 차단",
  wide_funnel: "측면 유도",
  one_v_one: "1대1",
  numerical_advantage: "수적 우위",
  numerical_disadvantage: "수적 열세",
};

export function defenseTypeLabel(defenseType: DefenseType): string {
  return DEFENSE_LABELS[defenseType];
}

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
