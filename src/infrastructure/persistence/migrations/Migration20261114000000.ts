import { Migration } from "@mikro-orm/migrations";

// O saldo observado é da wallet, que pode ter moeda diferente da transação (caso CURRENCY_MISMATCH).
export class Migration20261114000000 extends Migration {
  override up(): void {
    this.addSql(`alter table wager_transactions add column observed_currency char(3);`);
    // linhas finalizadas são imutáveis; o trigger sai só durante o preenchimento
    this.addSql(`alter table wager_transactions disable trigger trg_terminal_immutable;`);
    this.addSql(`
      update wager_transactions t set observed_currency = w.currency
        from wallets w where w.id = t.wallet_id and t.observed_balance is not null;`);
    this.addSql(`alter table wager_transactions enable trigger trg_terminal_immutable;`);
    this.addSql(`
      alter table wager_transactions add constraint ck_observed_currency
        check ((observed_balance is null) = (observed_currency is null));`);
  }

  override down(): void {
    this.addSql(`alter table wager_transactions drop constraint if exists ck_observed_currency;`);
    this.addSql(`alter table wager_transactions drop column if exists observed_currency;`);
  }
}
