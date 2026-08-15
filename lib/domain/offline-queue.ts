export type PendingEvent = { eventId: string; answer: string };

export function mergePendingEvents<T extends PendingEvent>(existing: T[], incoming: T[]) {
  return [...new Map([...existing, ...incoming].map((event) => [event.eventId, event])).values()];
}

