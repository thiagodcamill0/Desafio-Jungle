import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createQueues } from "../../scripts/create-queues";
import { loadConfig } from "../../src/infrastructure/config";
import { createSqsClient, resolveQueueUrl } from "../../src/infrastructure/messaging/sqs";

export interface TestQueues {
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
  env: Record<string, string>;
}

export const sqs = createSqsClient(loadConfig());

// filas com nome único por execução, para os testes não verem mensagens uns dos outros
export async function createTestQueues(prefix: string, opts: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {}): Promise<TestQueues> {
  const tag = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const env = {
    WAGER_QUEUE_NAME: `${tag}-wager-transactions.fifo`,
    WAGER_DLQ_NAME: `${tag}-wager-transactions-dlq.fifo`,
    EVENTS_QUEUE_NAME: `${tag}-wagering-events.fifo`,
    MAX_RECEIVE_COUNT: String(opts.maxReceiveCount ?? 5),
    VISIBILITY_TIMEOUT_SECONDS: String(opts.visibilityTimeoutSeconds ?? 30),
  };
  await createQueues(loadConfig({ ...process.env, ...env }));
  return { wagerQueueName: env.WAGER_QUEUE_NAME, wagerDlqName: env.WAGER_DLQ_NAME, eventsQueueName: env.EVENTS_QUEUE_NAME, env };
}

// lê (e apaga) tudo que chegar na fila durante waitMs
export async function receiveAll(queueName: string, waitMs: number): Promise<any[]> {
  const url = await resolveQueueUrl(sqs, queueName);
  const bodies: any[] = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    for (const message of res.Messages ?? []) {
      bodies.push(parseBody(message.Body));
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return bodies;
}

export async function sendRaw(queueName: string, body: string, groupId: string, dedupId: string): Promise<void> {
  const url = await resolveQueueUrl(sqs, queueName);
  await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: dedupId }));
}

function parseBody(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? "null");
  } catch {
    return body;
  }
}
