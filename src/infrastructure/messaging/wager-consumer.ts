import { createHash } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { ConflictError, InboxPayloadMismatchError, TransientInfraError, ValidationError } from "../../application/errors";
import { text, wagerFields } from "../../application/input-schemas";
import type { FaultInjector, Metrics } from "../../application/ports";
import type { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { DomainError } from "../../domain/errors";
import { FailureCode } from "../../domain/failure-code";
import { canonicalJson } from "../../domain/payload-hash";
import type { AppConfig } from "../config";
import { addToLogContext, runWithLogContext } from "../observability/log-context";
import { resolveQueueUrl } from "./sqs";

export const CONSUMER_NAME = "wager-consumer";

const envelopeSchema = z.object({
  messageId: text,
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.iso.datetime({ offset: true }),
  data: wagerFields.extend({ idempotencyKey: text }),
});

export type HandleOutcome = "acked" | "retry" | "dead-lettered";

export interface WagerConsumerOptions {
  enabled: boolean;
  waitTimeSeconds: number;
  shutdownGraceMs: number;
}

const DEFAULTS: WagerConsumerOptions = { enabled: false, waitTimeSeconds: 10, shutdownGraceMs: 20_000 };
const MAX_RETRY_DELAY_SECONDS = 60;

// Mesmo caso de uso do HTTP. Ack só depois do commit: negócio = ack, transitório = retry, permanente = DLQ.
export class WagerConsumer {
  private readonly logger = new Logger("WagerConsumer");
  private readonly options: WagerConsumerOptions;
  private stopping = false;
  private abort = new AbortController();
  private loop?: Promise<void>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly config: Pick<AppConfig, "wagerQueueName" | "wagerDlqName" | "visibilityTimeoutSeconds" | "maxReceiveCount">,
    private readonly submitWager: SubmitWagerTransaction,
    private readonly metrics: Metrics,
    private readonly faults: FaultInjector,
    options: Partial<WagerConsumerOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.loop = this.run();
  }

  // SIGTERM: para de receber, termina o que está em andamento e devolve o resto para a fila
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (!this.loop) return;
    await Promise.race([this.loop, Bun.sleep(this.options.shutdownGraceMs)]);
  }

  async pollOnce(): Promise<HandleOutcome[]> {
    const queueUrl = await resolveQueueUrl(this.sqs, this.config.wagerQueueName);
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.config.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
      { abortSignal: this.abort.signal },
    );

    const outcomes: HandleOutcome[] = [];
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        await this.release(queueUrl, messages.slice(index));
        break;
      }
      outcomes.push(await this.handle(queueUrl, message));
    }
    return outcomes;
  }

  async handle(queueUrl: string, message: Message): Promise<HandleOutcome> {
    return runWithLogContext({ correlationId: message.MessageId ?? "unknown" }, () => this.process(queueUrl, message));
  }

  private async process(queueUrl: string, message: Message): Promise<HandleOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const parsed = parseEnvelope(message.Body);
    if (!parsed) return this.deadLetter(queueUrl, message, FailureCode.INVALID_PAYLOAD);

    const { messageId, data } = parsed;
    const { idempotencyKey, ...fields } = data;
    addToLogContext({ correlationId: messageId, messageId, walletId: data.walletId, providerId: data.providerId });
    const started = performance.now();
    try {
      const outcome = await this.submitWager.execute(
        { ...fields, idempotencyKey },
        { correlationId: messageId, inbox: { consumerName: CONSUMER_NAME, messageId, payloadHash: hashOf(parsed) } },
      );
      this.metrics.observe("processing_latency_seconds", (performance.now() - started) / 1_000, { source: "sqs" });
      if ("duplicateInbox" in outcome) {
        this.metrics.inc("duplicates_total", { source: "inbox" });
        this.logger.log({ msg: "duplicate message ignored (inbox)" });
      } else {
        if (outcome.idempotentReplay) this.metrics.inc("duplicates_total", { source: "idempotency" });
        else this.metrics.inc("transactions_total", { status: outcome.status, kind: data.kind, source: "sqs" });
        addToLogContext({ transactionId: outcome.transactionId });
        this.logger.log({ msg: "wager transaction decided", kind: data.kind, status: outcome.status, failureCode: outcome.failureCode, idempotentReplay: outcome.idempotentReplay });
      }
      this.faults.hit("after-commit-before-ack");
      await this.delete(queueUrl, message);
      return "acked";
    } catch (error) {
      const code = failureCodeOf(error);
      if (isPermanent(error) || receiveCount >= this.config.maxReceiveCount) {
        return this.deadLetter(queueUrl, message, code, messageId);
      }
      return this.retry(queueUrl, message, receiveCount, code, messageId);
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopping) break;
        this.logger.warn(`receive failed: ${error instanceof Error ? error.message : String(error)}`);
        await Bun.sleep(1_000);
      }
    }
  }

  private async retry(queueUrl: string, message: Message, receiveCount: number, code: FailureCode, messageId: string): Promise<HandleOutcome> {
    const delay = Math.min(2 ** receiveCount, MAX_RETRY_DELAY_SECONDS);
    this.metrics.inc("retries_total", { source: "sqs" });
    this.logger.warn(`retrying message ${messageId} in ${delay}s (receive ${receiveCount}, ${code})`);
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay }));
    return "retry";
  }

  private async deadLetter(queueUrl: string, message: Message, code: FailureCode, messageId?: string): Promise<HandleOutcome> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await resolveQueueUrl(this.sqs, this.config.wagerDlqName),
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { failureCode: { DataType: "String", StringValue: code } },
      }),
    );
    await this.delete(queueUrl, message);
    this.metrics.inc("dlq_messages_total", { reason: code });
    this.logger.error(`message ${messageId ?? message.MessageId} sent to DLQ (${code})`);
    return "dead-lettered";
  }

  private async delete(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  // mensagens recebidas mas não iniciadas voltam a ficar visíveis na hora
  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
    }
  }
}

function parseEnvelope(body: string | undefined): z.infer<typeof envelopeSchema> | null {
  try {
    const result = envelopeSchema.safeParse(JSON.parse(body ?? ""));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// hash do conteúdo da mensagem: o mesmo messageId com dados diferentes é detectado no inbox
function hashOf(envelope: z.infer<typeof envelopeSchema>): string {
  return createHash("sha256").update(canonicalJson({ type: envelope.type, data: envelope.data })).digest("hex");
}

function isPermanent(error: unknown): boolean {
  if (error instanceof TransientInfraError) return false;
  return error instanceof DomainError || error instanceof ValidationError || error instanceof ConflictError || error instanceof InboxPayloadMismatchError;
}

function failureCodeOf(error: unknown): FailureCode {
  if (error instanceof DomainError || error instanceof ValidationError || error instanceof ConflictError || error instanceof TransientInfraError) return error.code;
  if (error instanceof InboxPayloadMismatchError) return FailureCode.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH;
  return FailureCode.PROCESSING_FAILED;
}
