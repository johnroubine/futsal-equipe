-- À coller dans Supabase > SQL Editor > New query, puis "Run".
create table if not exists app_data (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- Accès public en lecture/écriture avec la clé "anon" (l'app n'a pas de
-- compte utilisateur : toute l'équipe partage la même donnée via un lien).
alter table app_data enable row level security;

create policy "public read" on app_data
  for select using (true);

create policy "public write" on app_data
  for insert with check (true);

create policy "public update" on app_data
  for update using (true);
