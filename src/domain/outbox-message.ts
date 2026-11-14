import type { IntegrationEvent } from "./events/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Evento gravado na mesma transação SQL da operação financeira e publicado depois do commit.
 * O id é o próprio eventId: uma republicação leva o mesmo id e o consumidor deduplica por ele.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** `now` padrão = occurredAt do evento: pronto para publicar imediatamente. */
  static enqueue(event: IntegrationEvent<unknown>, now: Date = event.occurredAt): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0, now, undefined);
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Falha ao publicar: incrementa attempts e agenda com backoff exponencial (2^n s, teto 60 s). */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(2 ** this._attempts * 1_000, MAX_RETRY_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
    };
  }
}
