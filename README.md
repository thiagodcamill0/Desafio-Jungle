# Distributed Wagering Processor

Serviço que processa operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS. Ele foi feito para continuar correto com mensagens duplicadas, fora de ordem e simultâneas, com várias instâncias rodando ao mesmo tempo e com o processo podendo morrer em qualquer ponto.

Stack: Bun 1.4.4, TypeScript strict, NestJS 12, MikroORM 7, PostgreSQL 18 e SQS via MiniStack, tudo orquestrado com Docker Compose.

As decisões de projeto e os trade-offs estão no [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.4.x
- Docker com Docker Compose

## Rodando localmente

```bash
docker compose up -d postgres sqs     # PostgreSQL na 5432, MiniStack (SQS) na 4566
cp .env.example .env
bun install
bun run migrate:up                    # cria o schema (a migration é reversível: bun run migrate:down)
bun run queues:create                 # cria as filas FIFO e a DLQ com redrive
bun run dev                           # API em http://localhost:3000
```

Uma instância roda quatro papéis: `api`, `consumer` (fila de entrada), `outbox` (publicador de eventos) e `pending` (worker de referências pendentes). A variável `APP_ROLES` liga e desliga cada um, por exemplo `APP_ROLES=api,outbox`.

### Três instâncias

```bash
docker compose up --build -d
curl localhost:3001/health/ready
curl localhost:3002/health/ready
curl localhost:3003/health/ready
```

O serviço `migrate` roda uma vez (migrations e filas) antes de `app-1`, `app-2` e `app-3` subirem. As três instâncias compartilham o mesmo banco e as mesmas filas. Um `docker compose stop app-1` manda SIGTERM: o consumidor termina a mensagem em andamento e o processo sai com código 0.

## Testes

Os testes de integração usam o PostgreSQL e o MiniStack de verdade, então os dois precisam estar no ar (`docker compose up -d postgres sqs`). Cada arquivo de teste cria um banco e filas próprios, que são descartados no fim.

```bash
bun run test:unit          # domínio e regras, sem I/O
bun run test:integration   # banco e fila reais, concorrência, 3 processos, crash e reinício (~75 s)
bun run test               # os dois
bun run typecheck
```

O teste de SIGTERM real com um processo filho é pulado no Windows, porque lá `kill` encerra o processo na hora. O comportamento foi verificado no container Linux com o `docker compose stop`. O shutdown com uma mensagem em andamento também tem teste próprio, que roda em qualquer sistema.

## API

| Método | Rota | Observação |
|---|---|---|
| `POST` | `/wallets` | saldo inicial > 0 gera uma transação `OPENING` com crédito no ledger |
| `GET` | `/wallets/:walletId` | |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | mais recente primeiro; cursor opaco; `limit` máximo de 200 |
| `POST` | `/wagering/transactions` | header `Idempotency-Key` obrigatório |
| `GET` | `/wagering/transactions/:transactionId` | |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo × ledger, nunca corrige |
| `GET` | `/health/live`, `/health/ready` | sem autenticação |
| `GET` | `/metrics` | Prometheus |

O mapeamento de status HTTP está no [ARCHITECTURE.md](ARCHITECTURE.md#códigos-de-falha-e-status-http).

### Exemplo de fluxo

```bash
API=http://localhost:3000
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1

# cria a wallet com 1000.00
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" | jq -r .id)

bet() {
  curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
    -H "Idempotency-Key: provider-a:$1" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",
         \"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"$2\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}$4}"
  echo
}

bet bet-1 BET 25.00            # 200 PROCESSED, saldo 975.00
bet bet-1 BET 25.00            # 200, mesmo transactionId, idempotentReplay: true
bet bet-1 BET 30.00            # 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH
bet refund-1 REFUND 25.00 ',"referenceExternalTransactionId":"bet-1"'   # 200, saldo volta a 1000.00
bet rollback-1 ROLLBACK 25.00 ',"referenceExternalTransactionId":"bet-1"' # 422 REFERENCE_ALREADY_REVERSED

curl -s "$API/wallets/$WALLET/ledger?limit=10"
curl -s -X POST $API/wallets/$WALLET/reconciliation
curl -s $API/providers/provider-a/wagering/transactions/bet-1
```

### Enviando pela fila

```bash
bun scripts/send-wager.ts "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"sqs-1\",\"playerId\":\"$PLAYER\",
  \"walletId\":\"$WALLET\",\"roundId\":\"round-2\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",
  \"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

O script monta o envelope `WagerTransactionRequested` da spec, gerando o `messageId` e um `idempotencyKey` padrão `{providerId}:{externalTransactionId}`, e envia para `wager-transactions.fifo` com `MessageGroupId = walletId`. Com o AWS CLI, o equivalente é:

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id "$(uuidgen)" \
  --message-body file://message.json
```

Os eventos de integração saem em `wagering-events.fifo`.

## Configuração

| Variável | Padrão | |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | |
| `SQS_ENDPOINT` | `http://localhost:4566` | |
| `APP_ROLES` | todos | `api,consumer,outbox,pending` |
| `VISIBILITY_TIMEOUT_SECONDS` | 30 | visibilidade da mensagem recebida |
| `MAX_RECEIVE_COUNT` | 5 | recebimentos antes da DLQ |
| `WAGER_QUEUE_NAME`, `WAGER_DLQ_NAME`, `EVENTS_QUEUE_NAME` | nomes da spec | |
| `LOG_LEVEL` | `info` | |

## Estrutura

```
src/domain/          Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos (sem Nest e sem ORM)
src/application/     casos de uso, regras, portas (interfaces) e erros de aplicação
src/infrastructure/  MikroORM, SQS (consumer e publisher), workers, logs, métricas, health
src/interface/http/  controllers, validação de entrada, mapeamento de erros, guard de autenticação
test/unit/           domínio puro
test/integration/    banco e fila reais, concorrência, múltiplas instâncias, falhas
```
