begin;

create or replace function pg_temp.seed_uuid(_key text)
returns uuid
language sql
immutable
as $$
  select (
    substr(hash, 1, 8) || '-' ||
    substr(hash, 9, 4) || '-' ||
    '4' || substr(hash, 14, 3) || '-' ||
    '8' || substr(hash, 18, 3) || '-' ||
    substr(hash, 21, 12)
  )::uuid
  from (select md5('maidan-seed:' || _key) as hash) hashed;
$$;

create temp table seed_profiles (
  profile_key text primary key,
  email text not null,
  phone text not null,
  display_name text not null,
  bio text not null,
  interests text[] not null,
  lat double precision not null,
  lng double precision not null,
  is_host boolean not null,
  host_verified boolean not null default false,
  host_rating numeric(3, 2),
  payout_ref text
) on commit drop;

insert into seed_profiles (
  profile_key, email, phone, display_name, bio, interests, lat, lng,
  is_host, host_verified, host_rating, payout_ref
) values
  ('hemant', 'hemant@seed.maidan.local', '+919900000001', 'Hemant Rao',
   'Endurance cyclist and sunrise-route regular around North Bengaluru.',
   array['cycling', 'trails', 'sunrise'], 13.0368, 77.5970, true, true, 4.91, 'phonepe-settlement-hemant'),
  ('ananya', 'ananya@seed.maidan.local', '+919900000002', 'Ananya Iyer',
   'Run coach who keeps city sessions welcoming and precise.',
   array['running', 'mobility', 'community'], 12.9763, 77.5929, true, true, 4.82, 'phonepe-settlement-ananya'),
  ('farah', 'farah@seed.maidan.local', '+919900000003', 'Farah Siddiqui',
   'Facilitator for reflective, craft-led, and nature-based gatherings.',
   array['breathwork', 'pottery', 'birding'], 12.9352, 77.6245, true, true, 4.76, 'phonepe-settlement-farah'),
  ('raghav', 'raghav@seed.maidan.local', '+919900000004', 'Raghav Menon',
   'Strength and conditioning coach focused on practical urban fitness.',
   array['strength', 'boxing', 'conditioning'], 12.9719, 77.6412, true, true, 4.70, 'phonepe-settlement-raghav'),
  ('meera', 'meera@seed.maidan.local', '+919900000005', 'Meera Krishnan',
   'Coffee educator and workshop host for slower weekend learning.',
   array['coffee', 'language', 'sound'], 12.9716, 77.6410, true, true, 4.88, 'phonepe-settlement-meera'),
  ('zoya', 'zoya@seed.maidan.local', '+919900000006', 'Zoya Khan',
   'Social wellness host mixing play, food, and low-pressure circles.',
   array['pickleball', 'fermentation', 'journaling'], 12.9349, 77.6239, true, true, 4.68, 'phonepe-settlement-zoya'),
  ('arjun', 'arjun@seed.maidan.local', '+919900000007', 'Arjun Prakash',
   'Photographer and skater building beginner-friendly public-space sessions.',
   array['photography', 'skating', 'movement'], 12.9063, 77.5857, true, false, 4.63, 'phonepe-settlement-arjun'),
  ('kavya', 'kavya@seed.maidan.local', '+919900000008', 'Kavya Hegde',
   'Yoga teacher and urban naturalist based around South Bengaluru.',
   array['yoga', 'trees', 'gardening'], 12.9060, 77.5854, true, true, 4.86, 'phonepe-settlement-kavya'),
  ('nisha', 'nisha@seed.maidan.local', '+919900000101', 'Nisha Pai',
   'Explorer looking for weekend rides and small creative workshops.',
   array['cycling', 'coffee', 'journaling'], 12.9719, 77.6411, false, false, null, null),
  ('vikram', 'vikram@seed.maidan.local', '+919900000102', 'Vikram Bhat',
   'Explorer who prefers early starts and practical skill sessions.',
   array['trails', 'running', 'birding'], 12.9354, 77.6241, false, false, null, null),
  ('priya', 'priya@seed.maidan.local', '+919900000103', 'Priya Nair',
   'Explorer balancing work weeks with accessible city wellness.',
   array['yoga', 'breathwork', 'community'], 12.9760, 77.5931, false, false, null, null),
  ('sanjay', 'sanjay@seed.maidan.local', '+919900000104', 'Sanjay Kulkarni',
   'Explorer interested in food, craft, and neighbourhood groups.',
   array['pottery', 'fermentation', 'coffee'], 12.9048, 77.5926, false, false, null, null),
  ('dev', 'dev@seed.maidan.local', '+919900000105', 'Dev Narayan',
   'Explorer using Maidan to find quiet, repeatable evening rituals.',
   array['sound', 'sleep', 'meditation'], 12.9714, 77.6398, false, false, null, null),
  ('lina', 'lina@seed.maidan.local', '+919900000106', 'Lina D''Souza',
   'Explorer who likes South Bengaluru yoga and nature walks.',
   array['gardening', 'yin', 'trees'], 12.9070, 77.5860, false, false, null, null);

insert into auth.users (
  id, aud, role, email, confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
select
  pg_temp.seed_uuid('profile:' || profile_key),
  'authenticated',
  'authenticated',
  email,
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('display_name', display_name, 'seed', true),
  now(),
  now()
from seed_profiles
on conflict (id) do update
set
  aud = excluded.aud,
  role = excluded.role,
  email = excluded.email,
  confirmed_at = excluded.confirmed_at,
  raw_app_meta_data = excluded.raw_app_meta_data,
  raw_user_meta_data = excluded.raw_user_meta_data,
  updated_at = excluded.updated_at;

insert into profiles (
  id, phone, display_name, avatar_url, bio, interests, home_location,
  created_at, updated_at
)
select
  pg_temp.seed_uuid('profile:' || profile_key),
  phone,
  display_name,
  'https://images.maidan.local/seed/profiles/' || profile_key || '.jpg',
  bio,
  interests,
  st_setsrid(st_makepoint(lng, lat), 4326)::geography,
  now(),
  now()
from seed_profiles
on conflict (id) do update
set
  phone = excluded.phone,
  display_name = excluded.display_name,
  avatar_url = excluded.avatar_url,
  bio = excluded.bio,
  interests = excluded.interests,
  home_location = excluded.home_location,
  updated_at = excluded.updated_at;

insert into host_profiles (
  id, profile_id, is_verified, payout_ref, rating, total_activities,
  created_at, updated_at
)
select
  pg_temp.seed_uuid('host_profile:' || profile_key),
  pg_temp.seed_uuid('profile:' || profile_key),
  host_verified,
  payout_ref,
  host_rating,
  0,
  now(),
  now()
from seed_profiles
where is_host
on conflict (profile_id) do update
set
  is_verified = excluded.is_verified,
  payout_ref = excluded.payout_ref,
  rating = excluded.rating,
  updated_at = excluded.updated_at;

create temp table seed_activities (
  activity_key text primary key,
  host_key text not null,
  title text not null,
  description text not null,
  pillar activity_pillar not null,
  category text not null,
  meeting_point text not null,
  lat double precision not null,
  lng double precision not null,
  base_price_inr int not null,
  capacity int not null,
  fairness_score numeric not null,
  slot_count int not null check (slot_count between 2 and 3),
  slot_day_offset int not null,
  start_time time not null,
  duration_minutes int not null
) on commit drop;

insert into seed_activities (
  activity_key, host_key, title, description, pillar, category, meeting_point,
  lat, lng, base_price_inr, capacity, fairness_score, slot_count,
  slot_day_offset, start_time, duration_minutes
) values
  ('nandi-hills-sunrise-trail-ride', 'hemant', 'Nandi Hills sunrise trail ride',
   'A supported early-morning trail ride through the Nandi foothills with regroup points and chai after sunrise.',
   'move', 'cycling', 'Nandi Hills base parking, near the ticket counter',
   13.3702, 77.6835, 1499, 12, 94, 3, 1, time '05:15', 210),
  ('cubbon-park-morning-run', 'ananya', 'Cubbon Park social 5K run',
   'A conversational loop through Cubbon Park with warm-up drills and a coffee cooldown nearby.',
   'move', 'running', 'Queen Victoria statue, Cubbon Park',
   12.9763, 77.5929, 299, 18, 87, 3, 2, time '06:30', 75),
  ('indiranagar-strength-flow', 'raghav', 'Indiranagar strength flow',
   'Bodyweight strength, mobility, and core work for people easing back into training.',
   'move', 'strength', 'Defence Colony park gate, Indiranagar',
   12.9719, 77.6412, 799, 10, 79, 2, 3, time '07:00', 90),
  ('koramangala-pickleball-basics', 'zoya', 'Koramangala pickleball basics',
   'Beginner pickleball drills, court etiquette, and short doubles games.',
   'move', 'pickleball', 'Indoor court off 80 Feet Road, Koramangala 4th Block',
   12.9352, 77.6245, 650, 8, 74, 2, 4, time '18:30', 90),
  ('jp-nagar-lake-yoga', 'kavya', 'JP Nagar lake yoga',
   'Gentle lakeside yoga for breath, balance, and lower-back release.',
   'move', 'yoga', 'Sarakki Lake north gate, JP Nagar',
   12.9063, 77.5857, 499, 14, 83, 3, 5, time '07:15', 75),
  ('nandi-hills-gravel-climb', 'hemant', 'Nandi Hills gravel climb clinic',
   'A focused climbing clinic for riders who want better pacing, braking, and descent confidence.',
   'move', 'cycling', 'Nandi Upachar parking, Devanahalli Road',
   13.3707, 77.6829, 1299, 10, 90, 2, 6, time '06:00', 180),
  ('cubbon-park-skate-drills', 'arjun', 'Cubbon Park skate drills',
   'Low-speed balance, stopping, and turning drills for beginner inline skaters.',
   'move', 'skating', 'Bandstand steps, Cubbon Park',
   12.9760, 77.5942, 450, 8, 71, 2, 7, time '16:30', 90),
  ('koramangala-boxing-conditioning', 'raghav', 'Koramangala boxing conditioning',
   'Pad work, footwork, and conditioning for first-timers and returning boxers.',
   'move', 'boxing', '5th Block studio near Jyoti Nivas College',
   12.9348, 77.6167, 700, 12, 76, 2, 1, time '19:00', 75),
  ('jp-nagar-badminton-rally', 'ananya', 'JP Nagar badminton rally hour',
   'Friendly rally practice with simple footwork cues and rotating partners.',
   'move', 'badminton', 'JP Nagar 6th Phase indoor court',
   12.9048, 77.5926, 600, 12, 78, 3, 2, time '18:00', 75),
  ('indiranagar-filter-coffee-brewing', 'meera', 'Indiranagar filter coffee brewing',
   'Hands-on South Indian filter coffee brewing with grind, decoction, and milk-texture basics.',
   'learn', 'coffee', '12th Main tasting room, Indiranagar',
   12.9716, 77.6410, 900, 10, 88, 2, 3, time '10:30', 120),
  ('koramangala-pottery-wheel-intro', 'farah', 'Koramangala pottery wheel intro',
   'A small-batch pottery wheel session covering centering, pulling, and trimming basics.',
   'learn', 'pottery', 'Koramangala 3rd Block ceramics studio',
   12.9370, 77.6220, 1200, 8, 86, 3, 4, time '11:00', 150),
  ('cubbon-park-tree-walk', 'kavya', 'Cubbon Park tree walk',
   'Learn to identify rain trees, gulmohars, and old avenue species on a slow park loop.',
   'learn', 'nature walk', 'Central Library steps, Cubbon Park',
   12.9758, 77.5909, 350, 20, 82, 2, 5, time '08:00', 120),
  ('jp-nagar-phone-photography', 'arjun', 'JP Nagar phone photography walk',
   'Composition, light, and editing basics taught through street corners and lake edges.',
   'learn', 'photography', 'Ranga Shankara entrance, JP Nagar',
   12.9113, 77.5868, 750, 12, 80, 2, 6, time '16:00', 135),
  ('indiranagar-kannada-for-newcomers', 'meera', 'Kannada for Indiranagar newcomers',
   'Useful conversational Kannada for cafes, autos, apartments, and neighbourhood errands.',
   'learn', 'language', 'Community room near CMH Road, Indiranagar',
   12.9784, 77.6408, 500, 16, 89, 3, 7, time '17:30', 90),
  ('koramangala-fermentation-basics', 'zoya', 'Koramangala fermentation basics',
   'Make quick pickles and probiotic drinks while learning food-safety fundamentals.',
   'learn', 'food', 'Home kitchen studio, Koramangala 6th Block',
   12.9329, 77.6228, 1100, 9, 84, 2, 1, time '11:30', 150),
  ('nandi-hills-birding-field-notes', 'farah', 'Nandi Hills birding field notes',
   'A field-sketch and bird-listing morning for beginners around the hill base.',
   'learn', 'birding', 'Nandi Hills discovery trail entrance',
   13.3689, 77.6821, 950, 12, 85, 2, 2, time '06:15', 180),
  ('jp-nagar-urban-gardening', 'kavya', 'JP Nagar balcony gardening lab',
   'Soil mixes, balcony light, herbs, and pest basics for small Bengaluru homes.',
   'learn', 'gardening', 'Mini terrace garden near Brigade Millennium, JP Nagar',
   12.8947, 77.5850, 650, 14, 81, 3, 3, time '09:30', 120),
  ('cubbon-park-mindful-breathwork', 'farah', 'Cubbon Park mindful breathwork',
   'A quiet breathwork circle under the trees, designed for beginners.',
   'feel', 'breathwork', 'Bamboo grove near Bal Bhavan, Cubbon Park',
   12.9772, 77.5950, 500, 16, 86, 2, 4, time '07:00', 75),
  ('indiranagar-sound-bath', 'meera', 'Indiranagar sound bath evening',
   'An intimate sound bath with bowls, chimes, and guided downshifting.',
   'feel', 'sound bath', 'HAL 2nd Stage studio, Indiranagar',
   12.9705, 77.6404, 900, 12, 87, 3, 5, time '19:30', 75),
  ('koramangala-journaling-circle', 'zoya', 'Koramangala journaling circle',
   'Low-pressure prompts, tea, and a facilitated check-in for reflective writing.',
   'feel', 'journaling', 'Quiet cafe room, Koramangala 5th Block',
   12.9357, 77.6208, 450, 10, 80, 2, 6, time '18:00', 90),
  ('jp-nagar-restorative-yin', 'kavya', 'JP Nagar restorative yin',
   'Long-held floor postures with props for deep rest after work.',
   'feel', 'yin yoga', 'JP Nagar 2nd Phase wellness studio',
   12.9098, 77.5861, 600, 12, 84, 3, 7, time '19:00', 75),
  ('nandi-hills-sunrise-meditation', 'hemant', 'Nandi Hills sunrise meditation',
   'A pre-dawn drive-up meditation and quiet sunrise sit with a gentle hill-base walk.',
   'feel', 'meditation', 'Nandi Hills viewpoint parking',
   13.3715, 77.6842, 700, 18, 82, 2, 1, time '05:30', 120),
  ('cubbon-park-community-picnic', 'ananya', 'Cubbon Park community picnic',
   'A no-alcohol Sunday picnic with games, introductions, and easy conversation prompts.',
   'feel', 'community', 'Lawn near the Museum Road entrance, Cubbon Park',
   12.9747, 77.5957, 400, 24, 77, 2, 2, time '16:00', 120),
  ('indiranagar-art-therapy-evening', 'farah', 'Indiranagar art therapy evening',
   'Guided mark-making and reflection for people who want a calming creative reset.',
   'feel', 'art therapy', 'Doopanahalli studio, Indiranagar',
   12.9678, 77.6407, 950, 10, 83, 2, 3, time '18:30', 120),
  ('koramangala-sleep-reset-workshop', 'meera', 'Koramangala sleep reset workshop',
   'A practical evening on sleep hygiene, wind-down rituals, and nervous-system cues.',
   'feel', 'sleep', 'Koramangala 7th Block community hall',
   12.9368, 77.6156, 800, 14, 79, 3, 4, time '18:45', 90);

insert into activities (
  id, host_id, title, description, pillar, category, meeting_point, location,
  base_price_inr, currency, capacity, fairness_score, status, media, embedding,
  created_at, updated_at
)
select
  pg_temp.seed_uuid('activity:' || activity_key),
  pg_temp.seed_uuid('profile:' || host_key),
  title,
  description,
  pillar,
  category,
  meeting_point,
  st_setsrid(st_makepoint(lng, lat), 4326)::geography,
  base_price_inr,
  'INR',
  capacity,
  fairness_score,
  'published',
  jsonb_build_array(
    jsonb_build_object(
      'type', 'image',
      'url', 'https://images.maidan.local/seed/activities/' || activity_key || '.jpg',
      'alt', title
    )
  ),
  null,
  now(),
  now()
from seed_activities
on conflict (id) do update
set
  host_id = excluded.host_id,
  title = excluded.title,
  description = excluded.description,
  pillar = excluded.pillar,
  category = excluded.category,
  meeting_point = excluded.meeting_point,
  location = excluded.location,
  base_price_inr = excluded.base_price_inr,
  currency = excluded.currency,
  capacity = excluded.capacity,
  fairness_score = excluded.fairness_score,
  status = excluded.status,
  media = excluded.media,
  embedding = null,
  updated_at = excluded.updated_at;

update host_profiles hp
set
  total_activities = activity_counts.total_activities,
  updated_at = now()
from (
  select host_id, count(*)::int as total_activities
  from activities
  where id in (
    select pg_temp.seed_uuid('activity:' || activity_key)
    from seed_activities
  )
  group by host_id
) activity_counts
where hp.profile_id = activity_counts.host_id;

with generated_slots as (
  select
    pg_temp.seed_uuid('slot:' || a.activity_key || ':' || slot_no::text) as id,
    pg_temp.seed_uuid('activity:' || a.activity_key) as activity_id,
    (
      date_trunc('day', now()) +
      make_interval(days => a.slot_day_offset + (slot_no * 7)) +
      (a.start_time - time '00:00')
    ) as starts_at,
    (
      date_trunc('day', now()) +
      make_interval(days => a.slot_day_offset + (slot_no * 7)) +
      (a.start_time - time '00:00') +
      make_interval(mins => a.duration_minutes)
    ) as ends_at,
    a.capacity,
    'open'::slot_status as status
  from seed_activities a
  join generate_series(1, 3) as slots(slot_no)
    on slots.slot_no <= a.slot_count
)
insert into activity_slots (
  id, activity_id, starts_at, ends_at, capacity, booked_count, status,
  created_at, updated_at
)
select
  id, activity_id, starts_at, ends_at, capacity, 0, status, now(), now()
from generated_slots
on conflict (id) do update
set
  activity_id = excluded.activity_id,
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at,
  capacity = excluded.capacity,
  status = excluded.status,
  updated_at = excluded.updated_at;

create temp table seed_bookings (
  booking_key text primary key,
  activity_key text not null,
  slot_no int not null,
  explorer_key text not null,
  headcount int not null,
  amount_inr int not null,
  status booking_status not null,
  created_days_ago int not null
) on commit drop;

insert into seed_bookings (
  booking_key, activity_key, slot_no, explorer_key, headcount, amount_inr,
  status, created_days_ago
) values
  ('booking-nandi-nisha', 'nandi-hills-sunrise-trail-ride', 1, 'nisha', 2, 2998, 'confirmed', 3),
  ('booking-nandi-vikram', 'nandi-hills-sunrise-trail-ride', 1, 'vikram', 1, 1499, 'confirmed', 1),
  ('booking-cubbon-run-priya', 'cubbon-park-morning-run', 1, 'priya', 1, 299, 'confirmed', 4),
  ('booking-pottery-sanjay', 'koramangala-pottery-wheel-intro', 2, 'sanjay', 2, 2400, 'cancelled', 2),
  ('booking-sound-dev', 'indiranagar-sound-bath', 1, 'dev', 1, 900, 'confirmed', 2),
  ('booking-yin-lina', 'jp-nagar-restorative-yin', 2, 'lina', 1, 600, 'refunded', 5);

insert into bookings (
  id, slot_id, explorer_id, headcount, amount_inr, status, payment_id,
  created_at, updated_at
)
select
  pg_temp.seed_uuid('booking:' || booking_key),
  pg_temp.seed_uuid('slot:' || activity_key || ':' || slot_no::text),
  pg_temp.seed_uuid('profile:' || explorer_key),
  headcount,
  amount_inr,
  status,
  null,
  now() - make_interval(days => created_days_ago),
  now()
from seed_bookings
on conflict (id) do update
set
  slot_id = excluded.slot_id,
  explorer_id = excluded.explorer_id,
  headcount = excluded.headcount,
  amount_inr = excluded.amount_inr,
  status = excluded.status,
  updated_at = excluded.updated_at;

create temp table seed_payments (
  payment_key text primary key,
  booking_key text not null,
  phonepe_order_id text not null,
  phonepe_txn_id text,
  amount_inr int not null,
  platform_fee_inr int not null,
  host_payout_inr int not null,
  status payment_status not null
) on commit drop;

insert into seed_payments (
  payment_key, booking_key, phonepe_order_id, phonepe_txn_id, amount_inr,
  platform_fee_inr, host_payout_inr, status
) values
  ('payment-nandi-nisha', 'booking-nandi-nisha', 'MAIDAN-SEED-B001', 'TXN-SEED-B001', 2998, 450, 2548, 'success'),
  ('payment-nandi-vikram', 'booking-nandi-vikram', 'MAIDAN-SEED-B002', 'TXN-SEED-B002', 1499, 225, 1274, 'success'),
  ('payment-cubbon-run-priya', 'booking-cubbon-run-priya', 'MAIDAN-SEED-B003', 'TXN-SEED-B003', 299, 45, 254, 'success'),
  ('payment-pottery-sanjay', 'booking-pottery-sanjay', 'MAIDAN-SEED-B004', 'TXN-SEED-B004', 2400, 360, 2040, 'failed'),
  ('payment-sound-dev', 'booking-sound-dev', 'MAIDAN-SEED-B005', 'TXN-SEED-B005', 900, 135, 765, 'success'),
  ('payment-yin-lina', 'booking-yin-lina', 'MAIDAN-SEED-B006', 'TXN-SEED-B006', 600, 90, 510, 'refunded');

insert into payments (
  id, booking_id, phonepe_order_id, phonepe_txn_id, amount_inr,
  platform_fee_inr, host_payout_inr, status, idempotency_key, raw_callback,
  created_at, updated_at
)
select
  pg_temp.seed_uuid('payment:' || payment_key),
  pg_temp.seed_uuid('booking:' || booking_key),
  phonepe_order_id,
  phonepe_txn_id,
  amount_inr,
  platform_fee_inr,
  host_payout_inr,
  status,
  pg_temp.seed_uuid('booking:' || booking_key)::text,
  jsonb_build_object('seed', true, 'phonepe_order_id', phonepe_order_id, 'status', status),
  now(),
  now()
from seed_payments
on conflict (id) do update
set
  booking_id = excluded.booking_id,
  phonepe_order_id = excluded.phonepe_order_id,
  phonepe_txn_id = excluded.phonepe_txn_id,
  amount_inr = excluded.amount_inr,
  platform_fee_inr = excluded.platform_fee_inr,
  host_payout_inr = excluded.host_payout_inr,
  status = excluded.status,
  idempotency_key = excluded.idempotency_key,
  raw_callback = excluded.raw_callback,
  updated_at = excluded.updated_at;

update bookings b
set
  payment_id = pg_temp.seed_uuid('payment:' || p.payment_key),
  updated_at = now()
from seed_payments p
where b.id = pg_temp.seed_uuid('booking:' || p.booking_key);

with seed_slot_ids as (
  select
    pg_temp.seed_uuid('slot:' || a.activity_key || ':' || slot_no::text) as slot_id
  from seed_activities a
  join generate_series(1, 3) as slots(slot_no)
    on slots.slot_no <= a.slot_count
),
booked as (
  select
    slot_id,
    coalesce(sum(headcount) filter (where status = 'confirmed'), 0)::int as booked_count
  from bookings
  where slot_id in (select slot_id from seed_slot_ids)
  group by slot_id
)
update activity_slots s
set
  booked_count = coalesce(booked.booked_count, 0),
  status = case
    when coalesce(booked.booked_count, 0) >= s.capacity then 'full'::slot_status
    else 'open'::slot_status
  end,
  updated_at = now()
from seed_slot_ids
left join booked on booked.slot_id = seed_slot_ids.slot_id
where s.id = seed_slot_ids.slot_id;

insert into posts (
  id, author_id, body, media, linked_activity_id, created_at
) values
  (
    pg_temp.seed_uuid('post:trail-ride'),
    pg_temp.seed_uuid('profile:hemant'),
    'Scouted the Nandi foothill trail this week. The sunrise ride has clean regroup points, a tea stop, and a gentle return roll.',
    '[]'::jsonb,
    pg_temp.seed_uuid('activity:nandi-hills-sunrise-trail-ride'),
    now() - interval '2 days'
  ),
  (
    pg_temp.seed_uuid('post:cubbon-run'),
    pg_temp.seed_uuid('profile:ananya'),
    'Cubbon Park is at its best before 7 AM. Keeping the next social run beginner-paced.',
    '[]'::jsonb,
    pg_temp.seed_uuid('activity:cubbon-park-morning-run'),
    now() - interval '3 days'
  ),
  (
    pg_temp.seed_uuid('post:coffee'),
    pg_temp.seed_uuid('profile:meera'),
    'Filter coffee class notes: grind size and water temperature change the cup more than most people expect.',
    '[]'::jsonb,
    pg_temp.seed_uuid('activity:indiranagar-filter-coffee-brewing'),
    now() - interval '4 days'
  ),
  (
    pg_temp.seed_uuid('post:breathwork'),
    pg_temp.seed_uuid('profile:farah'),
    'The breathwork circle stays small so there is enough room for quiet arrivals and unrushed exits.',
    '[]'::jsonb,
    pg_temp.seed_uuid('activity:cubbon-park-mindful-breathwork'),
    now() - interval '5 days'
  ),
  (
    pg_temp.seed_uuid('post:explorer-note'),
    pg_temp.seed_uuid('profile:nisha'),
    'Booked my first Nandi ride. Looking forward to a cool start and breakfast after the descent.',
    '[]'::jsonb,
    null,
    now() - interval '1 day'
  )
on conflict (id) do update
set
  author_id = excluded.author_id,
  body = excluded.body,
  media = excluded.media,
  linked_activity_id = excluded.linked_activity_id,
  created_at = excluded.created_at;

insert into group_chats (
  id, activity_id, title, created_at
) values (
  pg_temp.seed_uuid('chat:nandi-hills-sunrise-trail-ride'),
  pg_temp.seed_uuid('activity:nandi-hills-sunrise-trail-ride'),
  'Nandi Hills sunrise trail ride',
  now()
)
on conflict (id) do update
set
  activity_id = excluded.activity_id,
  title = excluded.title;

insert into chat_members (
  chat_id, profile_id, joined_at
)
select
  pg_temp.seed_uuid('chat:nandi-hills-sunrise-trail-ride'),
  pg_temp.seed_uuid('profile:' || member_key),
  now() - make_interval(days => joined_days_ago)
from (
  values
    ('hemant', 6),
    ('nisha', 3),
    ('vikram', 1),
    ('priya', 1)
) as members(member_key, joined_days_ago)
on conflict (chat_id, profile_id) do update
set joined_at = excluded.joined_at;

insert into messages (
  id, chat_id, sender_id, body, created_at
)
select
  pg_temp.seed_uuid('message:' || message_key),
  pg_temp.seed_uuid('chat:nandi-hills-sunrise-trail-ride'),
  pg_temp.seed_uuid('profile:' || sender_key),
  body,
  now() - make_interval(hours => hours_ago)
from (
  values
    ('nandi-chat-1', 'hemant', 'Route note: we roll from the base parking at 5:15 sharp and regroup before the steeper section.', 30),
    ('nandi-chat-2', 'nisha', 'I am bringing lights and a windcheater. Is the tea stop cash-only?', 24),
    ('nandi-chat-3', 'hemant', 'Tea stall takes UPI now. Carry one bottle; I will have a pump and basic tools.', 22),
    ('nandi-chat-4', 'vikram', 'First time on that side road. Happy to stay with the steady group.', 18)
) as seeded_messages(message_key, sender_key, body, hours_ago)
on conflict (id) do update
set
  chat_id = excluded.chat_id,
  sender_id = excluded.sender_id,
  body = excluded.body,
  created_at = excluded.created_at;

commit;
