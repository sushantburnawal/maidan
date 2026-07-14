alter table profiles
  alter column phone drop not null;

alter table profiles
  add column if not exists firebase_uid text,
  add column if not exists email text;

create unique index if not exists profiles_firebase_uid_key
  on profiles (firebase_uid)
  where firebase_uid is not null;

create unique index if not exists profiles_email_lower_key
  on profiles (lower(email))
  where email is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_identity_check'
      and conrelid = 'profiles'::regclass
  ) then
    alter table profiles
      add constraint profiles_identity_check
      check (phone is not null or firebase_uid is not null);
  end if;
end
$$;
