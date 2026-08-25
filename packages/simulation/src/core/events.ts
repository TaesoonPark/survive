import type { SimEvent } from '@survive/protocol';

/**
 * Collects the events emitted during one tick.
 *
 * Systems only ever push; the host drains once per tick and fans the events out to
 * clients (filtered by area of interest) and to any test listeners.
 */
export interface EventSink {
  emit(event: SimEvent): void;
  /** Events emitted so far this tick. */
  readonly pending: readonly SimEvent[];
}

export class TickEventSink implements EventSink {
  private events: SimEvent[] = [];
  private listeners: ((event: SimEvent) => void)[] = [];

  emit(event: SimEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  get pending(): readonly SimEvent[] {
    return this.events;
  }

  /** Take everything emitted since the last drain. */
  drain(): SimEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  /**
   * Subscribe to every event as it is emitted. Used by tests and server logging;
   * never by gameplay code, which must not depend on event ordering.
   */
  subscribe(listener: (event: SimEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }
}
