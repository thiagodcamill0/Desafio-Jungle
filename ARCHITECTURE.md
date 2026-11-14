# Arquitetura e decisões

Este documento explica como o serviço garante as invariantes financeiras e por que cada decisão foi tomada. Onde a spec deixou espaço para interpretação, a escolha está registrada em [Interpretações da spec](#interpretações-da-spec).

## Visão geral

```
HTTP ──► WageringController ─┐
                             ├─► SubmitWagerTransaction ──► TransactionRunner (1 transação SQL)
SQS  ──► WagerConsumer ──────┤        (mesmo caso de uso)      ├─ SELECT wallet FOR UPDATE
                             │                                 ├─ idempotência / referência / regras
Worker de pendentes ─────────┘                                 ├─ INSERT transação + ledger, UPDATE wallet
                                                               ├─ INSERT inbox (SQS) + outbox (eventos)
                                                               └─ COMMIT
OutboxPublisher (toda instância) ── SELECT … FOR UPDATE SKIP LOCKED ──► wagering-events.fifo
```

Camadas no estilo portas e adaptadores:

- `src/domain`: `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage` e os eventos. É TypeScript puro, sem Nest e sem ORM, com construtores privados e factories (`create`, `open`, `from`, `rehydrate`). O `rehydrate` reconstrói o estado salvo sem revalidar transições.
- `src/application`: os casos de uso (`OpenWallet`, `SubmitWagerTransaction`, `ReconcileWallet`, consultas), as regras (`wager-rules.ts`) e as portas (`ports.ts`). O caso de uso não sabe que existe MikroORM nem SQS.
- `src/infrastructure`: os adaptadores (repositórios MikroORM, `TransactionRunner`, consumidor e publicador SQS, workers, logs, métricas e health).
- `src/interface/http`: controllers, validação com zod e uma tabela única que traduz erros para status HTTP.

Toda instância roda o mesmo binário. `APP_ROLES` liga a API, o consumidor, o publicador da outbox e o worker de pendentes. O Compose sobe três réplicas idênticas.

## ORM e mapeamento do `Money`

**MikroORM 7** (a spec prefere ele ao TypeORM). Uso o ORM como mapeador e query builder, não como Unit of Work:

- as tabelas são descritas com `EntitySchema` sobre tipos de linha (`schemas.ts`), e os `mappers.ts` convertem linha ↔ domínio. Nenhum decorator entra no domínio;
- as leituras usam `disableIdentityMap`, e as escritas usam `insert` e `nativeUpdate` explícitos. Quem guarda o estado em memória é o objeto de domínio, não um cache do ORM. Toda escrita aparece no código, inclusive a condição de versão (`UPDATE … WHERE id = ? AND version = ?`);
- onde a API do ORM não alcança (`ON CONFLICT DO NOTHING` no inbox e a soma do ledger), uso SQL parametrizado pelo próprio `EntityManager`.

**Dinheiro:**

- O `Money` guarda **centavos em `bigint`** e a moeda. Nenhuma conta usa `number`.
- A entrada é sempre uma string no formato `^(0|[1-9]\d{0,16})\.\d{2}$`, ou seja, até 17 dígitos inteiros e exatamente 2 casas, para caber em `NUMERIC(19,2)`.
- São rejeitados (com `INVALID_MONEY`): `NaN`, `Infinity`, notação científica, string vazia, sinal, espaços, número em vez de string e mais de 2 casas. O valor nunca é arredondado.
- Toda operação devolve uma instância nova. Operar moedas diferentes lança `CurrencyMismatchError`.
- No banco ficam duas colunas, `amount NUMERIC(19,2)` e `currency CHAR(3)`. O driver devolve `NUMERIC` como string (`"25.00"`), e o mapper reidrata `Money` direto dela, sem passar por `number`.
- No contrato externo e nos eventos o formato é `{ "amount": "25.00", "currency": "BRL" }`.

## Estratégia transacional

O `MikroOrmTransactionRunner` é o único lugar que abre transação. Cada chamada de caso de uso roda inteira dentro de **uma** transação SQL, com `SET LOCAL lock_timeout = '5s'`. Nessa mesma transação gravo:

1. o inbox, quando a entrada é SQS;
2. a transação de aposta, já decidida e com o snapshot do saldo;
3. o lançamento no ledger e a wallet com saldo e `version` novos;
4. os eventos na outbox.

Ou tudo existe, ou nada existe. O teste de atomicidade injeta um erro depois de todas as escritas e confere que nenhuma linha sobrou.

O runner também traduz os erros do driver:

| Erro do driver | Vira |
|---|---|
| `55P03` (lock_timeout) e `40P01` (deadlock) | `TransientInfraError(LOCK_TIMEOUT)` |
| conexão recusada ou derrubada (`08*`, `57P0x`, `ECONNREFUSED`…) | `TransientInfraError(DATABASE_UNAVAILABLE)` |
| `23505` | `UniqueViolationError(constraint)` |

## Concorrência

A unidade de concorrência é a **wallet**.

| | Abordagem | A favor | Contra |
|---|---|---|---|
| **A** | **lock pessimista por wallet** (`SELECT … FOR UPDATE`) | simples de explicar e de provar; correto com N instâncias porque quem trava é o banco; lock de linha, nunca global; a regra fica na `Wallet` | uma hot wallet é processada em série |
| B | lock otimista (`version`) com retry | ninguém espera | 50 cópias da mesma aposta geram uma tempestade de retries |
| C | update condicionado (`… WHERE balance >= x`) | menos round-trips | a regra de negócio sai do domínio e vai para o SQL |

**Escolhi A.** A ordem dentro do caso de uso é o ponto principal:

1. trava a wallet;
2. **só então** procura a `Idempotency-Key`.

Duas cópias simultâneas da mesma aposta disputam o mesmo lock. A segunda só lê depois do commit da primeira, encontra a transação gravada e devolve replay. É por isso que 50 requisições iguais em paralelo resultam em 1 débito e 49 replays.

Há defesa em profundidade: se algo escapar do lock, o banco ainda recusa.

- `UPDATE wallets … WHERE version = anterior`: zero linhas afetadas vira `ConcurrencyError`.
- `UNIQUE(idempotency_key)`: na violação, o caso de uso refaz a transação uma vez e cai no replay.
- `CHECK (balance >= 0)` e os triggers da próxima seção.

Para conferir que os testes realmente pegam erro, removi o `FOR UPDATE`. O teste 100/80/80 entre instâncias falhou. O de 50 cópias continuou passando, segurado pelo `UNIQUE` da key.

Wallets diferentes não compartilham lock nenhum e rodam em paralelo. Os workers (outbox e pendentes) usam `FOR UPDATE SKIP LOCKED`, então várias instâncias dividem o trabalho sem coordenação.

## Invariantes garantidas no schema

A migration (`Migration20261113000000`, com `up` e `down`) coloca no banco o que não pode depender só do código:

| Invariante | Como |
|---|---|
| uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK (balance >= 0)`, também em `balance_before` e `balance_after` do ledger |
| `version` sobe exatamente 1 quando o saldo muda, e não muda quando o saldo não muda | trigger `trg_wallet_version` |
| saldo da wallet = `balance_after` do último lançamento, nos dois sentidos | constraint trigger `DEFERRABLE INITIALLY DEFERRED`, checada no commit |
| lançamento com a conta certa | `CHECK (balance_after = balance_before ± amount)` |
| no máximo um lançamento por transação por wallet | `UNIQUE (wallet_id, transaction_id)` |
| ledger imutável | trigger que recusa `UPDATE`, `DELETE` e `TRUNCATE` |
| idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| uma reversão por referência | índice único parcial `ux_single_reversal (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| transação terminal imutável e nenhuma transação apagada | trigger `trg_terminal_immutable` |
| REFUND/ROLLBACK com referência; REJECTED/FAILED com `failure_code` | `CHECK`s |
| dedup do inbox | `PRIMARY KEY (consumer_name, message_id)` |

A constraint trigger de saldo × ledger é o que torna impossível existir um saldo sem lançamento correspondente, ou um lançamento sem o saldo correspondente, mesmo que algum código escreva direto no banco.

## Estados da transação

```
PENDING ──► PROCESSED            (terminal)
   │    ──► REJECTED             (terminal, com failureCode)
   │    ──► FAILED               (terminal, auditável)
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
              └── reagendada pelo worker enquanto a referência não chega
```

- `PENDING` só existe dentro da transação SQL: nenhuma transação sai do caso de uso nesse estado.
- Mudar uma transação terminal lança `InvalidTransactionStateError`. Isso é erro de programação, não caminho de negócio, e o trigger do banco repete a garantia.
- Toda transação persistida guarda o **saldo observado no momento da decisão** (`observed_balance`). É assim que o replay devolve "o resultado original, incluindo o saldo daquele momento", mesmo depois de outras apostas terem mudado o saldo.
- `FAILED` existe no modelo e no schema para erro permanente que não é de negócio. Na prática, os fluxos atuais terminam em `PROCESSED` ou `REJECTED`, e as falhas de infraestrutura são tratadas como transitórias e com retry.

## Regras de negócio

| Kind | Saldo | Ledger | Referência |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | não aceita |
| `WIN` | crédito | 1 `CREDIT` | opcional; se vier, precisa ser uma `BET` da mesma rodada |
| `LOSS` | não muda | nenhum | não aceita; `amount` pode ser `0.00` |
| `REFUND` | crédito | 1 `CREDIT` | obrigatória, só `BET`, valor igual |
| `ROLLBACK` | inverso da referência | 1 invertido | obrigatória: `BET`, `WIN` ou `REFUND`, valor igual |
| `OPENING` | crédito | 1 `CREDIT` | interno, criado só pelo `POST /wallets` |

A ordem de validação dentro da transação é esta:

1. A transação precisa ser do dono da wallet (`WALLET_PLAYER_MISMATCH`) e na moeda da wallet (`CURRENCY_MISMATCH`). Isso é checado antes de procurar a referência, para que um REFUND do player errado seja recusado na hora em vez de esperar a referência.
2. A referência é resolvida por `(providerId, referenceExternalTransactionId)`. Se não existe, ou se ela própria está `PENDING_REFERENCE`, a transação fica `PENDING_REFERENCE` e a resposta é 202.
3. A referência precisa ser do mesmo provider, player, wallet, moeda e rodada (`REFERENCE_MISMATCH`), de um kind permitido (`REFERENCE_KIND_NOT_ALLOWED`), estar `PROCESSED` (`REFERENCE_NOT_PROCESSED`) e, na reversão, ter o mesmo valor (`REFERENCE_AMOUNT_MISMATCH`) e ainda não ter sido revertida (`REFERENCE_ALREADY_REVERSED`).
4. A wallet aplica o débito ou crédito. Saldo insuficiente vira `INSUFFICIENT_FUNDS` numa BET e `REVERSAL_INSUFFICIENT_FUNDS` numa reversão. São situações diferentes para a operação: a primeira é o jogador sem saldo, a segunda é dinheiro que já foi gasto antes de o provedor desfazer a operação.

As rejeições são persistidas como `REJECTED`, geram o evento `WagerTransactionRejected` e não tocam saldo nem ledger.

## Idempotência e `payloadHash`

- O `Idempotency-Key` é obrigatório. Ele passa por `trim()`, e vazio dá 400 `MISSING_IDEMPOTENCY_KEY`. A key é a fonte da verdade, e o formato recomendado é `{providerId}:{externalTransactionId}`.
- **O `payloadHash` é o SHA-256 (hex) do JSON canônico dos campos de negócio**: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId`.
  - JSON canônico aqui quer dizer chaves ordenadas recursivamente, sem espaços e com campos `undefined` omitidos. Números não finitos e `bigint` são recusados.
  - Ficam de fora o header, a própria key, o `messageId` e o `occurredAt`. A mesma operação gera o mesmo hash por HTTP ou por SQS.
- Ordem das checagens, já com a wallet travada:
  1. Mesma key e mesmo hash: replay. A resposta é o resultado salvo, com `idempotentReplay: true` e o mesmo status HTTP da primeira vez, inclusive 422.
  2. Mesma key com hash diferente: 409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`. É conflito, não replay.
  3. Key nova reutilizando um `(providerId, externalTransactionId)` já usado: 409 `EXTERNAL_TRANSACTION_ID_REUSED`, detectado pelo `UNIQUE`.
- O replay de uma transação ainda em `PENDING_REFERENCE` devolve o estado atual. Se o worker já a resolveu, devolve o resultado resolvido.

## Códigos de falha e status HTTP

Todos os endpoints respondem erro no mesmo formato, `{ code, message }`. Na rejeição de negócio, o corpo também traz `transactionId`, `status`, `balance`, `failureCode` e `idempotentReplay`.

| HTTP | Situação | Códigos | O provedor deve |
|---|---|---|---|
| 200 | processada (nova ou replay) | — | seguir |
| 201 | wallet criada | — | — |
| 202 | aceita, aguardando a referência | — | consultar depois ou esperar o evento |
| 400 | payload inválido | `INVALID_PAYLOAD`, `INVALID_MONEY`, `MISSING_IDEMPOTENCY_KEY`, `KIND_NOT_ALLOWED` | corrigir e reenviar |
| 404 | recurso de consulta inexistente | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `ROUTE_NOT_FOUND` | — |
| 409 | conflito | `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, `EXTERNAL_TRANSACTION_ID_REUSED`, `WALLET_ALREADY_EXISTS` | não reenviar o mesmo pedido |
| 422 | rejeição de negócio (terminal) | `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `WALLET_NOT_FOUND`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED` | desistir; o replay devolve o mesmo 422 |
| 503 + `Retry-After: 1` | falha transitória | `DATABASE_UNAVAILABLE`, `LOCK_TIMEOUT`, `QUEUE_UNAVAILABLE` | reenviar com backoff |

`WALLET_NOT_FOUND` aparece em dois lugares. Num `GET`, é 404. Ao submeter uma transação, é 422 e **não é persistida**, porque não há wallet a que associar a transação.

O consumidor SQS usa a mesma classificação:

| Resultado | Ação |
|---|---|
| processada, rejeitada (422) ou pendente | ack |
| 400 / 409, wallet inexistente, `messageId` repetido com conteúdo diferente | DLQ na hora |
| 503, erro inesperado | retry |

## Referências fora de ordem (`PENDING_REFERENCE`)

Um worker em cada instância roda a cada 1 s:

1. pega as transações `PENDING_REFERENCE` vencidas com `SKIP LOCKED`;
2. para cada uma, chama `SubmitWagerTransaction.resolvePending`, que usa o mesmo núcleo de decisão do submit;
3. trava primeiro a wallet, depois a transação, e confere sob o lock que ela ainda está pendente e vencida. Assim dois workers não contam a mesma tentativa duas vezes.

**Política:** a primeira tentativa acontece 1 s depois. As seguintes usam backoff exponencial `2^n s` com teto de 60 s. São **10 tentativas no total** (1, 2, 4, 8, 16, 32, 60, 60, 60, 60 s), uma janela de **cerca de 5 minutos**. Depois disso a transação vira `REJECTED` com `REFERENCE_NOT_FOUND`, e o evento `WagerTransactionRejected` é publicado.

Por que 5 minutos: o provedor costuma mandar a referência em segundos, e o atraso real vem de rede e de fila. Cinco minutos cobrem isso com folga sem deixar dinheiro pendurado por horas. Reagendar não gera evento: só a decisão final gera.

## Mensageria

### Consumidor SQS (`wager-transactions.fifo`)

- Ele valida o envelope da spec com zod e chama **o mesmo** `SubmitWagerTransaction` do HTTP.
- O **inbox** é gravado na mesma transação da operação, com chave `(consumerName, messageId)`.
  - `messageId` já visto com o mesmo conteúdo: duplicata. A métrica conta, e a mensagem recebe ack sem fazer mais nada.
  - Mesmo `messageId` com conteúdo diferente: DLQ. O hash do inbox é o SHA-256 do JSON canônico de `{ type, data }`.
  - Se o processamento falha antes do commit, a linha do inbox também desaparece, e a reentrega é processada normalmente.
- O **ack (delete) só acontece depois do commit**. Se o processo morrer entre o commit e o ack, a mensagem volta depois do visibility timeout, o inbox a reconhece e nada é aplicado duas vezes. Há teste disso com um processo real morto nesse ponto exato.
- **Retry:** um erro transitório faz `ChangeMessageVisibility` de `min(2^receiveCount, 60)` segundos. Quando `receiveCount` chega a `MAX_RECEIVE_COUNT` (5 por padrão), o consumidor manda a mensagem para a DLQ, com o atributo `failureCode`. A `RedrivePolicy` da fila continua lá como rede extra, para o caso de um processo que morre antes de conseguir classificar o erro.
- **SIGTERM:**
  1. o consumidor para de chamar `ReceiveMessage` e aborta o long poll;
  2. termina a mensagem em andamento, com até 20 s de tolerância;
  3. devolve com `ChangeMessageVisibility(0)` as mensagens recebidas que ainda não começaram;
  4. o processo sai com código 0.

  O `main.ts` trata o sinal ele mesmo, porque o `enableShutdownHooks` do Nest re-emite o sinal e o processo sai com código diferente de zero.

### Transactional outbox (`wagering-events.fifo`)

- Os eventos são gravados na tabela `outbox_messages` na mesma transação da operação. **Nenhum evento é publicado antes do commit.**
- Cada instância roda o `OutboxPublisher` a cada 500 ms, sempre na mesma transação:
  1. `SELECT … WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY seq LIMIT 50 FOR UPDATE SKIP LOCKED`;
  2. publica cada evento no SQS (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`);
  3. marca o evento como publicado;
  4. commit.
- **Vários publishers:** o `SKIP LOCKED` faz cada um pegar linhas diferentes. O teste com dois publishers e 100 mensagens termina com cada mensagem publicada exatamente uma vez.
- **Crash entre publicar e marcar:** a transação não comita, a linha volta a ficar pendente e outra instância publica de novo **com o mesmo `eventId`**. O SQS FIFO deduplica dentro da janela de 5 minutos, e o `eventId` estável deixa o consumidor deduplicar fora dela. Esse é exatamente o cenário da spec, e ele tem teste com um processo morto com `exit 137` logo depois do primeiro publish.
- Com o SQS fora do ar, a mensagem que falhou é reagendada (`2^attempts s`, teto de 60 s) e o resto do lote fica para a próxima rodada. Evento nunca é descartado.

### Eventos

`IntegrationEvent<T>` é uma classe abstrata com `eventId`, `aggregateId` (a wallet), `correlationId`, `causationId` (o `messageId` da entrada, quando ela vem do SQS), `occurredAt` (ISO-8601 no JSON) e `data`. Cada evento é uma subclasse com `eventType` e `version = 1` fixos no tipo. O `data` carrega `MoneyProps` (strings), nunca `Money`.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | rejeição por regra de negócio, inclusive `REFERENCE_NOT_FOUND` depois das tentativas |
| `WagerTransactionPendingReference` | a referência ainda não chegou |
| `WalletBalanceChanged` | só quando o saldo muda. Leva `walletVersion`, para o consumidor ordenar |

## Reconciliação

`POST /wallets/:id/reconciliation` trava a wallet (para ler saldo e ledger no mesmo instante), soma o ledger e devolve `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`. **Ela nunca corrige nada.** Uma divergência aparece de três formas: `consistent: false` na resposta, um log de erro e a métrica `reconciliation_mismatches_total`. Corrigir em silêncio esconderia um bug financeiro.

## Observabilidade

- **Logs JSON (pino)**. Toda linha leva o contexto atual: `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Esse contexto vive num `AsyncLocalStorage`, aberto pelo middleware HTTP e pelo consumidor. O `X-Correlation-Id` recebido é reaproveitado (ou criado) e volta na resposta. Valores, saldos e payloads não vão para o log: só ids, kind e status. Também há `redact` como segunda proteção.
- **Métricas Prometheus** em `GET /metrics`:

  | Métrica | O que mede |
  |---|---|
  | `wager_transactions_total{status,kind,source}` | transações decididas |
  | `duplicates_total{source=idempotency\|inbox}` | duplicatas detectadas |
  | `retries_total` | retries |
  | `dlq_messages_total{reason}` | mensagens mandadas para a DLQ |
  | `lock_conflicts_total{reason=timeout\|slow_wait\|version}` | `slow_wait` = espera pelo lock acima de 100 ms |
  | `outbox_lag_seconds` | idade do evento pendente mais antigo |
  | `processing_latency_seconds{source}` | histograma de latência |
  | `reconciliation_mismatches_total` | divergências de reconciliação |

- **Health**: `/health/live` só diz que o processo responde. `/health/ready` faz `SELECT 1` e `GetQueueUrl` com timeout de 2 s cada e responde 503 se algum falhar. Liveness e readiness ficam separados para o orquestrador tirar a instância do balanceador quando o banco piscar, sem reiniciar um processo saudável.

## Autenticação

Não está implementada, porque não vale pontos e competiria com o núcleo financeiro. O ponto de extensão já existe no código: `ProviderAuthGuard` está aplicado aos controllers de wallet e de transação e delega para a porta `ProviderIdentityPort`, que hoje aceita qualquer chamada (`AllowAllProviderIdentity`). Os health checks ficam fora do guard.

O desenho que eu adotaria:

1. **Keycloak** como IdP, com um client por provedor de jogos e o fluxo *client credentials*.
2. O `ProviderIdentityPort` real valida o JWT no JWKS do realm (assinatura, `exp`, `aud`), com o JWKS em cache.
3. O guard extrai o `providerId` do token (claim `azp` ou um claim próprio) e confere que ele é igual ao `providerId` do corpo ou da rota. Divergência dá 403. Assim um provedor não consegue mexer em transações de outro.
4. Nenhuma tabela própria de usuários ou senhas.
5. A fila é um canal interno confiável, sem token. Mesmo assim, o `providerId` da mensagem passa pelas mesmas validações de domínio: a referência precisa ser do mesmo provider, e a wallet do mesmo player.

## Interpretações da spec

1. **Uma reversão por transação, de qualquer tipo.** A spec diz "não pode ser revertida duas vezes pelo mesmo tipo de operação". Lido ao pé da letra, uma BET poderia receber um REFUND e depois um ROLLBACK, e o dinheiro voltaria duas vezes, contra a invariante "sem crédito duplicado". Escolhi a regra mais forte: depois de um REFUND ou ROLLBACK processado, qualquer outra reversão da mesma referência recebe `REFERENCE_ALREADY_REVERSED`. Isso é garantido pelo índice `ux_single_reversal`. O ROLLBACK de um REFUND continua permitido, porque reverte o REFUND, que é outra transação.
2. **WIN com referência** precisa apontar para uma BET do mesmo provider, player, wallet, moeda e rodada, mas o valor **não** é comparado, porque o prêmio normalmente é diferente da aposta. WIN sem referência é processado normalmente.
3. **BET ou LOSS com `referenceExternalTransactionId`** dá 400 `INVALID_PAYLOAD`. Preferi recusar a ignorar em silêncio um campo que o provedor mandou.
4. **Wallet inexistente ao submeter** dá 422 sem persistir pelo HTTP, e vai para a DLQ pelo SQS. O id da wallet é gerado pelo servidor, então uma wallet inexistente é erro do produtor e não pode sumir com um ack.
5. **`LOSS`** aceita `amount = "0.00"`, porque só registra o resultado. Os outros kinds exigem valor positivo.
6. **`OPENING`** gera só `WalletBalanceChanged`, não `WagerTransactionProcessed`, por ser uma transação interna.
7. **A fila de eventos** se chama `wagering-events.fifo`, já que a spec não nomeia o destino dos eventos.
8. **Dinheiro em formato errado**, inclusive `amount` numérico, dá 400 `INVALID_MONEY`, não `INVALID_PAYLOAD`. O código é mais útil para o provedor saber o que corrigir.
9. **Um replay pelo SQS** (`messageId` novo, mesma key) recebe ack e conta como duplicata de idempotência.
10. **O ledger** é paginado do lançamento mais recente para o mais antigo. O cursor é o `seq` do lançamento codificado em base64url, e por isso é estável mesmo com lançamentos novos chegando no meio da paginação, o que não aconteceria com `OFFSET`.

## Testes

- `test/unit` (106 testes): `Money` (escala, entradas inválidas, limites, conflito de moeda), `Wallet`, ledger, máquina de estados da transação, hash canônico, eventos, inbox e outbox, regras de BET/WIN/LOSS/REFUND/ROLLBACK e `validateReference`.
- `test/integration` (117 testes, PostgreSQL e MiniStack reais, nada de mock de banco ou fila):
  - **Schema:** constraints, triggers, `down` + `up` da migration.
  - **Persistência:** repositórios, lock e `lock_timeout`.
  - **HTTP:** cada status HTTP.
  - **Atomicidade:** wallet, ledger, inbox e outbox na mesma transação.
  - **Concorrência:** a mesma aposta 50 vezes em paralelo, o cenário 100/80/80 e 10 wallets × 20 apostas.
  - **Referências:** referência fora de ordem, com relógio fake no worker.
  - **Outbox:** dois publishers concorrentes, SQS fora do ar e processo morto entre publicar e comitar.
  - **Consumidor:** inbox e redelivery, DLQ, retry transitório, processo morto entre commit e ack e shutdown com mensagem em andamento.
  - **Observabilidade:** métricas, logs e readiness com o banco ou o SQS fora do ar.
  - **Múltiplas instâncias:** três processos Bun independentes, com `kill -9` no meio da carga e reconciliação consistente depois do reinício.
- Todo teste que mexe em saldo termina com `assertLedgerMatchesBalance`. Ele confere que o saldo gravado é igual ao último `balance_after` e à soma de créditos menos débitos.

## Limitações e próximos passos

- **Hot wallet:** uma wallet muito disputada é processada em série, por causa do lock. Foi aceito: um jogador não aposta milhares de vezes por segundo. Se isso virasse problema, o próximo passo seria agrupar as mensagens da mesma wallet num único lock.
- **Ordem dos eventos entre publishers:** com vários publishers, ou depois de uma falha de publicação, eventos da mesma wallet podem sair fora de ordem. O consumidor deve ordenar por `walletVersion`.
- **Publicação dentro da transação de claim:** o lote fica travado durante os envios, com até 50. É simples e seguro contra crash. Com volume maior, usaria `SendMessageBatch` e lotes menores.
- **Testes com uma moeda só:** os testes usam BRL. O modelo é multi-moeda, e o conflito de moeda tem teste.
- **SIGTERM real no Windows:** o teste com processo filho é pulado no Windows e foi verificado no container Linux.
- **Não feito por causa do prazo:** teste de carga (`test:load`), OpenTelemetry, dashboard, ledger de partidas dobradas e autenticação real (desenho acima).
