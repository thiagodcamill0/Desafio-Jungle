import { describe, expect, test } from "bun:test";
import { canonicalJson, computePayloadHash, type WagerPayloadFields } from "../../src/domain/payload-hash";

const fields: WagerPayloadFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("ordena chaves recursivamente e não usa espaços", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("omite undefined, preserva null e arrays em ordem", () => {
    expect(canonicalJson({ z: undefined, y: null, x: [3, 1, { b: 2, a: 1 }] })).toBe('{"x":[3,1,{"a":1,"b":2}],"y":null}');
  });

  test("rejeita valores que não são JSON (ex.: bigint)", () => {
    expect(() => canonicalJson({ a: 1n })).toThrow();
  });
});

describe("computePayloadHash", () => {
  test("é SHA-256 hex (64 caracteres) e determinístico", () => {
    const hash = computePayloadHash(fields);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash({ ...fields })).toBe(hash);
  });

  test("não depende da ordem das chaves", () => {
    const reordered = Object.fromEntries(
      Object.entries({ ...fields, money: { currency: "BRL", amount: "25.00" } }).reverse(),
    ) as unknown as WagerPayloadFields;
    expect(Object.keys(reordered)[0]).toBe("money");
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(fields));
  });

  test("muda quando um campo de negócio muda", () => {
    expect(computePayloadHash({ ...fields, money: { amount: "25.01", currency: "BRL" } })).not.toBe(computePayloadHash(fields));
    expect(computePayloadHash({ ...fields, roundId: "round-988" })).not.toBe(computePayloadHash(fields));
  });

  test("referência undefined equivale a ausente; referência presente muda o hash", () => {
    expect(computePayloadHash({ ...fields, referenceExternalTransactionId: undefined })).toBe(computePayloadHash(fields));
    expect(computePayloadHash({ ...fields, referenceExternalTransactionId: "bet-1" })).not.toBe(computePayloadHash(fields));
  });

  test("ignora campos que não são de negócio (idempotencyKey, messageId, occurredAt)", () => {
    const withTransport = { ...fields, idempotencyKey: "k", messageId: "m", occurredAt: "2026-07-29T15:00:00.000Z" };
    expect(computePayloadHash(withTransport as WagerPayloadFields)).toBe(computePayloadHash(fields));
  });
});
