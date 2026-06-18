drop index if exists payments_idempotency_key_idx;

alter table payments
  drop column if exists idempotency_key;
