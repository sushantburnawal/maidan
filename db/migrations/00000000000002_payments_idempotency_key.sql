alter table payments
  add column idempotency_key text;

update payments
set idempotency_key = booking_id::text
where idempotency_key is null;

alter table payments
  alter column idempotency_key set not null;

create unique index payments_idempotency_key_idx on payments (idempotency_key);
