import { CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig, type AppConfig } from "../src/infrastructure/config";

const FIFO = { FifoQueue: "true", ContentBasedDeduplication: "false" };

export async function createQueues(config: AppConfig): Promise<void> {
  const client = new SQSClient({
    endpoint: config.sqsEndpoint,
    region: config.awsRegion,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" },
  });
  // CreateQueue é idempotente quando os atributos são iguais; o redrive é aplicado depois, via SetQueueAttributes.
  const dlq = await client.send(new CreateQueueCommand({ QueueName: config.wagerDlqName, Attributes: FIFO }));
  const dlqAttrs = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }));
  const main = await client.send(new CreateQueueCommand({ QueueName: config.wagerQueueName, Attributes: FIFO }));
  await client.send(new SetQueueAttributesCommand({
    QueueUrl: main.QueueUrl,
    Attributes: {
      VisibilityTimeout: String(config.visibilityTimeoutSeconds),
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqAttrs.Attributes?.QueueArn, maxReceiveCount: config.maxReceiveCount }),
    },
  }));
  await client.send(new CreateQueueCommand({ QueueName: config.eventsQueueName, Attributes: FIFO }));
  client.destroy();
}

if (import.meta.main) {
  const config = loadConfig();
  await createQueues(config);
  console.log(`queues ready: ${config.wagerQueueName}, ${config.wagerDlqName}, ${config.eventsQueueName}`);
}
