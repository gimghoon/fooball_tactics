export type PendingEvent = { eventId: string };

export type AttemptDeliveryDisposition = "accepted" | "retry" | "rejected";

export function attemptDeliveryDisposition(status: number | null): AttemptDeliveryDisposition {
  if (status === null || (status >= 500 && status < 600)) return "retry";
  if (status >= 200 && status < 300) return "accepted";
  return "rejected";
}

export function attemptDeliveryFeedback(
  disposition: Exclude<AttemptDeliveryDisposition, "accepted">,
  message: string,
): { queue: boolean; message: string } {
  return disposition === "retry"
    ? { queue: true, message: `${message} 답안은 기기에 임시 저장했어요.` }
    : { queue: false, message };
}

export function mergePendingEvents<T extends PendingEvent>(existing: T[], incoming: T[]) {
  return [...new Map([...existing, ...incoming].map((event) => [event.eventId, event])).values()];
}
