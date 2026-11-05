-- Estado completo del sistema de turnos (una fila, JSONB) con control de versión optimista.
-- RLS activado y SIN políticas: el público (anon/authenticated) no puede leer ni escribir.
-- Solo la Edge Function "turnos" (service role) accede, y devuelve al navegador una
-- versión sin datos personales.
create table if not exists public.app_estado (
  id         int primary key check (id = 1),
  data       jsonb not null,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.app_estado enable row level security;
revoke all on public.app_estado from anon, authenticated;
