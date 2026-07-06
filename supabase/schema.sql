create extension if not exists pgcrypto;

create table if not exists public.users (
  id text primary key default gen_random_uuid()::text,
  auth_user_id uuid references auth.users(id) on delete set null,
  email text,
  display_name text not null default 'Guest Visitor',
  role text not null default 'student' check (role in ('student', 'admin')),
  institution_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users add column if not exists email text;
alter table public.users drop constraint if exists users_role_check;
alter table public.users alter column role set default 'student';
update public.users set role = 'student' where role = 'visitor';
alter table public.users
  add constraint users_role_check check (role in ('student', 'admin'));

create unique index if not exists users_auth_user_id_unique
  on public.users (auth_user_id)
  where auth_user_id is not null;

create index if not exists users_email_index
  on public.users (email);

create table if not exists public.categories (
  id text primary key,
  key text not null unique,
  name text not null,
  description text not null default '',
  color text not null default '#3B82F6',
  icon text not null default 'sparkles-outline',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.public_information (
  id text primary key default gen_random_uuid()::text,
  category_id text not null references public.categories(id) on delete cascade,
  title text not null,
  body text not null,
  info_type text not null default 'general',
  location_name text,
  requirements jsonb not null default '[]'::jsonb,
  tags text[] not null default '{}',
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.faqs (
  id text primary key default gen_random_uuid()::text,
  category_id text not null references public.categories(id) on delete cascade,
  question text not null,
  answer text not null,
  tags text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id text primary key default gen_random_uuid()::text,
  user_id text references public.users(id) on delete set null,
  category_id text references public.categories(id) on delete set null,
  title text not null default 'Public assistance chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id text primary key default gen_random_uuid()::text,
  conversation_id text not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.recent_questions (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references public.users(id) on delete cascade,
  question text not null,
  normalized_question text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, normalized_question)
);

create index if not exists recent_questions_user_updated_index
  on public.recent_questions (user_id, updated_at desc);

create table if not exists public.announcements (
  id text primary key default gen_random_uuid()::text,
  category_id text not null references public.categories(id) on delete cascade,
  title text not null,
  body text not null,
  priority text not null default 'normal' check (priority in ('normal', 'important', 'urgent')),
  is_published boolean not null default true,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.feedback (
  id text primary key default gen_random_uuid()::text,
  user_id text references public.users(id) on delete set null,
  category_id text references public.categories(id) on delete set null,
  message text not null,
  rating int not null default 5 check (rating between 1 and 5),
  created_at timestamptz not null default now()
);

create table if not exists public.voice_usage (
  user_id text primary key references public.users(id) on delete cascade,
  free_seconds int not null default 120,
  purchased_seconds int not null default 0,
  used_seconds int not null default 0,
  remaining_seconds int generated always as (
    greatest(0, free_seconds + purchased_seconds - used_seconds)
  ) stored,
  updated_at timestamptz not null default now()
);

alter table public.voice_usage alter column free_seconds set default 120;

create table if not exists public.device_voice_usage (
  device_hash text primary key,
  device_id_source text not null default 'unknown',
  free_seconds int not null default 120,
  purchased_seconds int not null default 0,
  used_seconds int not null default 0,
  remaining_seconds int generated always as (
    greatest(0, free_seconds + purchased_seconds - used_seconds)
  ) stored,
  last_user_id text references public.users(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(device_hash) between 32 and 128),
  check (free_seconds >= 0 and purchased_seconds >= 0 and used_seconds >= 0)
);

create index if not exists device_voice_usage_last_user_index
  on public.device_voice_usage (last_user_id);

create table if not exists public.voice_packages (
  id text primary key,
  label text not null,
  price_pesos numeric(10, 2) not null,
  minutes int not null,
  seconds int generated always as (minutes * 60) stored,
  status text not null default 'coming_soon' check (status in ('active', 'coming_soon', 'disabled')),
  payment_gateway_status text not null default 'pending_future_integration',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.voice_transactions (
  id text primary key default gen_random_uuid()::text,
  user_id text references public.users(id) on delete set null,
  package_id text references public.voice_packages(id) on delete set null,
  amount_pesos numeric(10, 2) not null,
  purchased_minutes int not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled')),
  payment_gateway text not null default 'pending_future_integration',
  external_reference text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

insert into public.categories (id, key, name, description, color, icon)
values
  ('school', 'school', 'School', 'Enrollment, offices, schedules, rules, and announcements.', '#3B82F6', 'school-outline'),
  ('government', 'government', 'Government', 'Documents, forms, office hours, and public service steps.', '#14B8A6', 'business-outline'),
  ('public_places', 'public_places', 'Public Places', 'Directions, safety reminders, facilities, and lost and found.', '#F59E0B', 'map-outline'),
  ('others', 'others', 'Others', 'Custom public information support.', '#FB7185', 'sparkles-outline')
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  color = excluded.color,
  icon = excluded.icon,
  updated_at = now();

insert into public.voice_packages (id, label, price_pesos, minutes, status)
values
  ('voice-30', '30 minutes', 10, 30, 'coming_soon'),
  ('voice-60', '1 hour', 20, 60, 'coming_soon'),
  ('voice-180', '3 hours', 50, 180, 'coming_soon')
on conflict (id) do update set
  label = excluded.label,
  price_pesos = excluded.price_pesos,
  minutes = excluded.minutes,
  status = excluded.status,
  updated_at = now();

insert into public.faqs (id, category_id, question, answer, tags)
values
  (
    'faq-school-enrollment',
    'school',
    'How do I enroll?',
    'For enrollment, prepare your report card, birth certificate, good moral certificate, and ID photo. Go to the Registrar first, submit your documents, then wait for section and schedule confirmation.',
    array['enrollment', 'registrar', 'requirements']
  ),
  (
    'faq-government-clearance',
    'government',
    'How do I get a barangay clearance?',
    'Bring a valid ID, proof of address, and payment if required. Go to the Barangay Hall, fill out the form, submit your documents, and wait for release.',
    array['barangay', 'clearance', 'documents']
  ),
  (
    'faq-government-nbi-clearance',
    'government',
    'How do I get an NBI clearance?',
    'For NBI Clearance, apply online first at clearance.nbi.gov.ph. Create or log in to your account, complete your applicant information, choose your NBI branch and appointment schedule, select a payment option, pay using the generated reference number, then go to your chosen NBI branch on your appointment date for biometrics and printing. Bring two valid government-issued IDs and your reference number or proof of payment. If you get a HIT, follow the release date or verification advice from NBI.',
    array['nbi', 'clearance', 'online appointment', 'biometrics', 'government id']
  ),
  (
    'faq-place-lost-found',
    'public_places',
    'Where is lost and found?',
    'Go to the Information Desk or Security Office. Describe the lost item clearly, show ID if claiming, and leave your contact number for updates.',
    array['lost and found', 'security', 'information desk']
  )
on conflict (id) do update set
  question = excluded.question,
  answer = excluded.answer,
  tags = excluded.tags,
  updated_at = now();

insert into public.public_information (
  id,
  category_id,
  title,
  body,
  info_type,
  location_name,
  requirements,
  tags
)
values
  (
    'info-government-nbi-clearance',
    'government',
    'NBI Clearance Online Appointment',
    'Use the official NBI Clearance portal at clearance.nbi.gov.ph. Register or log in, complete your applicant information, apply for clearance, choose an NBI clearance center with an appointment date and time, choose a payment channel, pay using the reference number, then visit the selected branch for photo, fingerprint, signature capture, and clearance printing.',
    'procedure',
    'Selected NBI Clearance Center',
    '["Two valid government-issued IDs", "NBI online account", "Reference number", "Proof of payment if available"]'::jsonb,
    array['nbi', 'clearance', 'online', 'appointment', 'payment', 'biometrics']
  )
on conflict (id) do update set
  title = excluded.title,
  body = excluded.body,
  info_type = excluded.info_type,
  location_name = excluded.location_name,
  requirements = excluded.requirements,
  tags = excluded.tags,
  updated_at = now();

alter table public.users enable row level security;
alter table public.categories enable row level security;
alter table public.public_information enable row level security;
alter table public.faqs enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.recent_questions enable row level security;
alter table public.announcements enable row level security;
alter table public.feedback enable row level security;
alter table public.voice_usage enable row level security;
alter table public.device_voice_usage enable row level security;
alter table public.voice_packages enable row level security;
alter table public.voice_transactions enable row level security;

drop policy if exists "Public read categories" on public.categories;
create policy "Public read categories" on public.categories
  for select using (is_active = true);

drop policy if exists "Public read published information" on public.public_information;
create policy "Public read published information" on public.public_information
  for select using (is_published = true);

drop policy if exists "Public read active faqs" on public.faqs;
create policy "Public read active faqs" on public.faqs
  for select using (is_active = true);

drop policy if exists "Public read announcements" on public.announcements;
create policy "Public read announcements" on public.announcements
  for select using (is_published = true);

drop policy if exists "Public read voice packages" on public.voice_packages;
create policy "Public read voice packages" on public.voice_packages
  for select using (true);

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users
    where users.auth_user_id = auth.uid()
      and users.role = 'admin'
  );
$$;

grant execute on function public.current_user_is_admin() to anon, authenticated;

drop policy if exists "Users manage own recent questions" on public.recent_questions;
create policy "Users manage own recent questions" on public.recent_questions
  for all using (
    public.current_user_is_admin()
    or exists (
      select 1
      from public.users
      where users.id = recent_questions.user_id
        and users.auth_user_id = auth.uid()
    )
  )
  with check (
    public.current_user_is_admin()
    or exists (
      select 1
      from public.users
      where users.id = recent_questions.user_id
        and users.auth_user_id = auth.uid()
    )
  );

drop policy if exists "Admins manage device voice usage" on public.device_voice_usage;
create policy "Admins manage device voice usage" on public.device_voice_usage
  for all using (public.current_user_is_admin()) with check (public.current_user_is_admin());

create or replace function public.get_or_create_device_voice_usage(
  p_device_hash text,
  p_device_source text default 'unknown',
  p_user_id text default null
)
returns table (
  device_hash text,
  free_seconds int,
  purchased_seconds int,
  used_seconds int,
  remaining_seconds int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_user_id text;
begin
  if p_device_hash is null or length(p_device_hash) < 32 or length(p_device_hash) > 128 then
    raise exception 'A valid device identifier is required.';
  end if;

  select users.id
  into safe_user_id
  from public.users
  where users.id = p_user_id
    and (
      users.auth_user_id = auth.uid()
      or public.current_user_is_admin()
    )
  limit 1;

  insert into public.device_voice_usage (
    device_hash,
    device_id_source,
    free_seconds,
    purchased_seconds,
    used_seconds,
    last_user_id,
    updated_at
  )
  values (
    p_device_hash,
    coalesce(nullif(p_device_source, ''), 'unknown'),
    120,
    0,
    0,
    safe_user_id,
    now()
  )
  on conflict on constraint device_voice_usage_pkey do update set
    device_id_source = coalesce(nullif(excluded.device_id_source, ''), device_voice_usage.device_id_source),
    last_user_id = coalesce(safe_user_id, device_voice_usage.last_user_id),
    updated_at = now();

  return query
  select
    usage.device_hash,
    usage.free_seconds,
    usage.purchased_seconds,
    usage.used_seconds,
    usage.remaining_seconds
  from public.device_voice_usage as usage
  where usage.device_hash = p_device_hash;
end;
$$;

create or replace function public.consume_device_voice_seconds(
  p_device_hash text,
  p_seconds int,
  p_user_id text default null
)
returns table (
  device_hash text,
  free_seconds int,
  purchased_seconds int,
  used_seconds int,
  remaining_seconds int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_user_id text;
  seconds_to_consume int;
begin
  if p_device_hash is null or length(p_device_hash) < 32 or length(p_device_hash) > 128 then
    raise exception 'A valid device identifier is required.';
  end if;

  seconds_to_consume := greatest(0, coalesce(p_seconds, 0));

  select users.id
  into safe_user_id
  from public.users
  where users.id = p_user_id
    and (
      users.auth_user_id = auth.uid()
      or public.current_user_is_admin()
    )
  limit 1;

  insert into public.device_voice_usage (
    device_hash,
    device_id_source,
    free_seconds,
    purchased_seconds,
    used_seconds,
    last_user_id,
    updated_at
  )
  values (
    p_device_hash,
    'unknown',
    120,
    0,
    0,
    safe_user_id,
    now()
  )
  on conflict on constraint device_voice_usage_pkey do nothing;

  update public.device_voice_usage as usage
  set
    used_seconds = least(
      usage.free_seconds + usage.purchased_seconds,
      usage.used_seconds + seconds_to_consume
    ),
    last_user_id = coalesce(safe_user_id, usage.last_user_id),
    updated_at = now()
  where usage.device_hash = p_device_hash;

  return query
  select
    usage.device_hash,
    usage.free_seconds,
    usage.purchased_seconds,
    usage.used_seconds,
    usage.remaining_seconds
  from public.device_voice_usage as usage
  where usage.device_hash = p_device_hash;
end;
$$;

grant execute on function public.get_or_create_device_voice_usage(text, text, text) to anon, authenticated;
grant execute on function public.consume_device_voice_seconds(text, int, text) to anon, authenticated;

drop policy if exists "Client insert users" on public.users;
drop policy if exists "Client update users" on public.users;
drop policy if exists "Users read own profile" on public.users;
create policy "Users read own profile" on public.users
  for select using (
    auth.uid() = auth_user_id
    or public.current_user_is_admin()
  );

drop policy if exists "Users create own profile" on public.users;
create policy "Users create own profile" on public.users
  for insert with check (
    auth.uid() = auth_user_id
    and role = 'student'
  );

drop policy if exists "Users update own profile" on public.users;
create policy "Users update own profile" on public.users
  for update using (
    auth.uid() = auth_user_id
    or public.current_user_is_admin()
  )
  with check (
    (auth.uid() = auth_user_id and role = 'student')
    or public.current_user_is_admin()
  );

drop policy if exists "Client write conversations" on public.conversations;
create policy "Client write conversations" on public.conversations
  for all using (true) with check (true);

drop policy if exists "Client write messages" on public.messages;
create policy "Client write messages" on public.messages
  for all using (true) with check (true);

drop policy if exists "Client write feedback" on public.feedback;
create policy "Client write feedback" on public.feedback
  for insert with check (true);

drop policy if exists "Client manage voice usage" on public.voice_usage;
drop policy if exists "Users read own voice usage" on public.voice_usage;
create policy "Users read own voice usage" on public.voice_usage
  for select using (
    public.current_user_is_admin()
    or exists (
      select 1
      from public.users
      where users.id = voice_usage.user_id
        and users.auth_user_id = auth.uid()
    )
  );

drop policy if exists "Users create own voice usage" on public.voice_usage;
create policy "Users create own voice usage" on public.voice_usage
  for insert with check (
    public.current_user_is_admin()
    or exists (
      select 1
      from public.users
      where users.id = voice_usage.user_id
        and users.auth_user_id = auth.uid()
    )
  );

drop policy if exists "Users update own voice usage" on public.voice_usage;
create policy "Users update own voice usage" on public.voice_usage
  for update using (
    public.current_user_is_admin()
    or exists (
      select 1
      from public.users
      where users.id = voice_usage.user_id
        and users.auth_user_id = auth.uid()
    )
  )
  with check (
    public.current_user_is_admin()
    or exists (
      select 1
      from public.users
      where users.id = voice_usage.user_id
        and users.auth_user_id = auth.uid()
    )
  );

drop policy if exists "Prototype admin manage categories" on public.categories;
drop policy if exists "Admins manage categories" on public.categories;
create policy "Admins manage categories" on public.categories
  for all using (public.current_user_is_admin()) with check (public.current_user_is_admin());

drop policy if exists "Prototype admin manage public information" on public.public_information;
drop policy if exists "Admins manage public information" on public.public_information;
create policy "Admins manage public information" on public.public_information
  for all using (public.current_user_is_admin()) with check (public.current_user_is_admin());

drop policy if exists "Prototype admin manage faqs" on public.faqs;
drop policy if exists "Admins manage faqs" on public.faqs;
create policy "Admins manage faqs" on public.faqs
  for all using (public.current_user_is_admin()) with check (public.current_user_is_admin());

drop policy if exists "Prototype admin manage announcements" on public.announcements;
drop policy if exists "Admins manage announcements" on public.announcements;
create policy "Admins manage announcements" on public.announcements
  for all using (public.current_user_is_admin()) with check (public.current_user_is_admin());

drop policy if exists "Admins read feedback" on public.feedback;
create policy "Admins read feedback" on public.feedback
  for select using (public.current_user_is_admin());

drop policy if exists "Client create voice transactions" on public.voice_transactions;
create policy "Client create voice transactions" on public.voice_transactions
  for insert with check (true);

drop policy if exists "Admins read voice transactions" on public.voice_transactions;
create policy "Admins read voice transactions" on public.voice_transactions
  for select using (public.current_user_is_admin());
