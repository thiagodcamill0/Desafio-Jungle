import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/ports";
import type { OutboxMessage } from "../../domain/outbox-message";
import type { AppConfig } from "../config";

export function createSqsClient(config: Pick<AppConfig, "sqsEndpoint" | "awsRegion">): SQSClient {
  return new SQSClient({
    endpoint: config.sqsEndpoint,
    region: config.awsRegion,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 25_000 },
  });
}

const queueUrls = new WeakMap<SQSClient, Map<string, Promise<string>>>();

export function resolveQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  let cache = queueUrls.get(client);
  if (!cache) queueUrls.set(client, (cache = new Map()));
  let url = cache.get(queueName);
  if (!url) {
    url = client.send(new GetQueueUrlCommand({ QueueName: queueName })).then((res) => res.QueueUrl!);
    url.catch(() => cache.delete(queueName));
    cache.set(queueName, url);
  }
  return url;
}

// Publica os eventos da outbox numa fila FIFO: grupo por wallet, dedup pelo eventId.
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await resolveQueueUrl(this.client, this.queueName),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }
}
