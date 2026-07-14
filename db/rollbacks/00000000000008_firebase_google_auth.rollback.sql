delete from profiles
where phone is null
  and firebase_uid is not null;

drop index if exists profiles_email_lower_key;
drop index if exists profiles_firebase_uid_key;

alter table profiles
  drop constraint if exists profiles_identity_check;

alter table profiles
  drop column if exists email,
  drop column if exists firebase_uid;

alter table profiles
  alter column phone set not null;
