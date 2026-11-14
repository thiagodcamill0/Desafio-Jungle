import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../src/infrastructure/config";
import { createSqsClient, resolveQueueUrl } from "../src/infrastructure/messaging/sqs";

// Envia uma WagerTransactionRequested para a fila de entrada.
// Uso: bun scripts/send-wager.ts '{"providerId":"p","externalTransactionId":"t1",...}'
const raw = process.argv[2];
if (!raw) throw new Error("usage: bun scripts/send-wager.ts '<json com os campos de data>'");

const data = JSON.parse(raw) as Record<string, unknown>;
data.idempotencyKey ??= `${data.providerId}:${data.externalTransactionId}`;
const message = { messageId: crypto.randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data };

const config = loadConfig();
const client = createSqsClient(config);
await client.send(
  new SendMessageCommand({
    QueueUrl: await resolveQueueUrl(client, config.wagerQueueName),
    MessageBody: JSON.stringify(message),
    MessageGroupId: String(data.walletId),
    MessageDeduplicationId: message.messageId,
  }),
);
console.log(`sent ${message.messageId}`);
client.destroy();
