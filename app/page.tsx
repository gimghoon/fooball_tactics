import type { Metadata } from "next";
import { FutsalApp } from "./FutsalApp";

export const metadata: Metadata = {
  title: "TACTIQ — 함께 익히는 풋살 전술",
  description: "다이아몬드 1-2-1을 역할별로 연습하고 경기장에서 실행하세요.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ room?: string }> }) {
  const { room } = await searchParams;
  return <FutsalApp initialInviteCode={room?.toUpperCase() ?? null} showEvidenceAdmin />;
}
