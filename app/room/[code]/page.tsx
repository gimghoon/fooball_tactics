import { RoomDashboard } from "./RoomDashboard";

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  return <RoomDashboard code={(await params).code.toUpperCase()} />;
}

