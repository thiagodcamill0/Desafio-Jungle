import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Controller, Get, Inject, Res } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { APP_CONFIG, SQS_CLIENT } from "../../tokens";
import type { AppConfig } from "../config";
import { PrometheusMetrics } from "./metrics";

type Check = "up" | "down";

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string): void;
}

const CHECK_TIMEOUT_MS = 2_000;

async function probe(fn: () => Promise<unknown>): Promise<Check> {
  try {
    await Promise.race([fn(), Bun.sleep(CHECK_TIMEOUT_MS).then(() => Promise.reject(new Error("timeout")))]);
    return "up";
  } catch {
    return "down";
  }
}

// Sem autenticação: liveness diz se o processo responde; readiness diz se as dependências respondem.
@Controller("health")
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res() res: HttpResponse): Promise<void> {
    const [database, sqs] = await Promise.all([
      probe(() => this.orm.em.getConnection().execute("select 1")),
      probe(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.wagerQueueName }))),
    ]);
    const ok = database === "up" && sqs === "up";
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "down", checks: { database, sqs } });
  }
}

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics) {}

  @Get()
  async scrape(@Res() res: HttpResponse): Promise<void> {
    res.setHeader("Content-Type", this.metrics.registry.contentType);
    res.status(200).send(await this.metrics.registry.metrics());
  }
}
