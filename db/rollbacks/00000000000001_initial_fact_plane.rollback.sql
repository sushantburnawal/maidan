begin;

drop table if exists domain_events cascade;
drop table if exists messages cascade;
drop table if exists chat_members cascade;
drop table if exists group_chats cascade;
drop table if exists posts cascade;
drop table if exists reviews cascade;
drop table if exists payments cascade;
drop table if exists bookings cascade;
drop table if exists activity_slots cascade;
drop table if exists activities cascade;
drop table if exists host_profiles cascade;
drop table if exists profiles cascade;

drop function if exists is_chat_member(uuid, uuid);
drop function if exists is_review_public(uuid);
drop function if exists can_read_booking(uuid, uuid);
drop function if exists is_booking_explorer(uuid, uuid);
drop function if exists is_slot_activity_host(uuid, uuid);
drop function if exists is_activity_host(uuid, uuid);
drop function if exists is_activity_published(uuid);
drop function if exists profile_has_public_post(uuid);
drop function if exists profile_has_published_activity(uuid);
drop function if exists set_updated_at();

drop type if exists payment_status;
drop type if exists booking_status;
drop type if exists slot_status;
drop type if exists activity_status;
drop type if exists activity_pillar;

commit;
