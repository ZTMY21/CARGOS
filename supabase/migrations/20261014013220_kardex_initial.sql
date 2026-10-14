-- Kardex Digital CD Santa Anita. Run on an empty, dedicated Supabase project.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table private.kardex_miembros (
  email text primary key check (email = lower(email)),
  rol text not null default 'editor' check (rol in ('editor', 'admin')),
  created_at timestamptz not null default now()
);
alter table private.kardex_miembros enable row level security;
revoke all on private.kardex_miembros from public, anon, authenticated;
-- Add the verified owner's membership privately after applying the migrations.

create function private.kardex_has_access(admin_only boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from auth.users u
    join private.kardex_miembros m on m.email = lower(u.email)
    where u.id = (select auth.uid()) and u.email_confirmed_at is not null
      and coalesce(u.is_anonymous,false) = false
      and (not admin_only or m.rol = 'admin')
  );
$$;
revoke all on function private.kardex_has_access(boolean) from public, anon;
grant execute on function private.kardex_has_access(boolean) to authenticated;

create table private.kardex_contadores (
  nombre text primary key check (nombre in ('req','doc')),
  valor bigint not null default 0 check (valor between 0 and 999999999999999)
);
alter table private.kardex_contadores enable row level security;
revoke all on private.kardex_contadores from public, anon, authenticated;
insert into private.kardex_contadores(nombre) values ('req'),('doc');

create table public.requerimientos (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique check (numero ~ '^REQ-[0-9]{5,15}$'),
  tipo text not null check (tipo in (
    'Cajas nuevas para acondicionar','Préstamo de Cajas (búsqueda de documentos)',
    'Solicitud de Recojo nuevos ingresos','Solicitud de Recojo por devolución de cajas','Otros'
  )),
  fecha_solicitud date not null,
  cantidad_cajas integer check (cantidad_cajas >= 0),
  numeros_cargo text not null default '',
  fecha_recepcion date,
  fecha_devolucion date,
  usuario text not null check (length(trim(usuario)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint req_campos check (
    (tipo = 'Cajas nuevas para acondicionar' and cantidad_cajas is not null)
    or (tipo <> 'Cajas nuevas para acondicionar' and length(trim(numeros_cargo)) > 0)
  )
);
create table public.documentos (
  id uuid primary key default gen_random_uuid(),
  kardex text not null unique check (kardex ~ '^SA-[0-9]{5,15}$'),
  fecha_registro date not null default (now() at time zone 'America/Lima')::date,
  tipo_doc text not null default 'Facturas-Guia' check (tipo_doc in (
    'Facturas-Guia','Boletas de Venta','Guías de Remisión','Fact / GR / BV'
  )),
  periodo date not null,
  ubicacion text not null default 'Santa Anita' check (ubicacion in ('Santa Anita','Iron Mountain','CD Arequipa','Otros')),
  folios integer check (folios >= 0),
  cargos text[] not null default '{}',
  caja_asignada uuid references public.requerimientos(id) on delete set null,
  f_envio date,
  sustento text not null default '',
  sustento_imagen text not null default '' check (
    sustento_imagen = '' or
    sustento_imagen ~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$'
  ),
  usuario text not null check (length(trim(usuario)) > 0),
  facturas text not null default '',
  obs text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documentos_caja_asignada_idx on public.documentos(caja_asignada);
create index documentos_periodo_idx on public.documentos(periodo);
alter table public.requerimientos enable row level security;
alter table public.documentos enable row level security;
revoke all on public.requerimientos, public.documentos from public, anon;
grant select, insert, update, delete on public.requerimientos, public.documentos to authenticated;
create policy kardex_requerimientos_select on public.requerimientos for select to authenticated
  using ((select private.kardex_has_access(false)));
create policy kardex_requerimientos_insert on public.requerimientos for insert to authenticated
  with check ((select private.kardex_has_access(false)));
create policy kardex_requerimientos_update on public.requerimientos for update to authenticated
  using ((select private.kardex_has_access(false))) with check ((select private.kardex_has_access(false)));
create policy kardex_requerimientos_delete on public.requerimientos for delete to authenticated
  using ((select private.kardex_has_access(false)));
create policy kardex_documentos_select on public.documentos for select to authenticated
  using ((select private.kardex_has_access(false)));
create policy kardex_documentos_insert on public.documentos for insert to authenticated
  with check ((select private.kardex_has_access(false)));
create policy kardex_documentos_update on public.documentos for update to authenticated
  using ((select private.kardex_has_access(false))) with check ((select private.kardex_has_access(false)));
create policy kardex_documentos_delete on public.documentos for delete to authenticated
  using ((select private.kardex_has_access(false)));

-- All writes share a transaction lock. Import/reset and ordinary CRUD cannot interleave.
create function private.kardex_write_lock() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1170196,1);
  return null;
end;
$$;
revoke all on function private.kardex_write_lock() from public, anon, authenticated;
create trigger req_statement_lock before insert or update or delete on public.requerimientos
for each statement execute function private.kardex_write_lock();
create trigger doc_statement_lock before insert or update or delete on public.documentos
for each statement execute function private.kardex_write_lock();

-- A private trigger owns counter updates and validates assignments under the same lock.
create function private.kardex_prepare_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  next_number bigint;
  imported boolean := coalesce(current_setting('kardex.importing',true),'') = 'on'
    and private.kardex_has_access(true);
  req public.requerimientos;
  used_count bigint;
begin
  if not private.kardex_has_access(false) then raise exception 'Cuenta no autorizada' using errcode='42501'; end if;
  if tg_op = 'INSERT' then
    if tg_table_name = 'requerimientos' then
      if new.numero is null then
        update private.kardex_contadores set valor=valor+1 where nombre='req' returning valor into next_number;
        new.numero := 'REQ-' || lpad(next_number::text,greatest(5,length(next_number::text)),'0');
      elsif not imported then raise exception 'El correlativo se asigna automáticamente'; end if;
    else
      if new.kardex is null then
        update private.kardex_contadores set valor=valor+1 where nombre='doc' returning valor into next_number;
        new.kardex := 'SA-' || lpad(next_number::text,greatest(5,length(next_number::text)),'0');
      elsif not imported then raise exception 'El correlativo se asigna automáticamente'; end if;
      if not imported then new.fecha_registro := (now() at time zone 'America/Lima')::date; end if;
    end if;
    new.created_at := clock_timestamp();
  else
    if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
      raise exception 'No se puede modificar la identidad del registro';
    end if;
    if tg_table_name = 'requerimientos' then
      if new.numero is distinct from old.numero then raise exception 'No se puede modificar el correlativo'; end if;
    else
      if new.kardex is distinct from old.kardex or new.fecha_registro is distinct from old.fecha_registro then
        raise exception 'No se puede modificar el correlativo o la fecha de registro';
      end if;
    end if;
  end if;
  if tg_table_name = 'documentos' and not imported then
    if new.caja_asignada is not null and (tg_op = 'INSERT' or new.caja_asignada is distinct from old.caja_asignada) then
      select * into req from public.requerimientos where id = new.caja_asignada for update;
      if not found or req.tipo <> 'Cajas nuevas para acondicionar' or req.fecha_recepcion is null then
        raise exception 'La caja debe pertenecer a un requerimiento de cajas nuevas recibido';
      end if;
      select count(*) into used_count from public.documentos where caja_asignada = req.id and id <> new.id;
      if used_count >= req.cantidad_cajas then
        raise exception 'Todas las cajas de este requerimiento ya están asignadas. Actualiza los datos.';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := greatest(clock_timestamp(),old.updated_at + interval '1 microsecond');
  else
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function private.kardex_prepare_row() from public, anon, authenticated;
create trigger req_prepare before insert or update on public.requerimientos
for each row execute function private.kardex_prepare_row();
create trigger doc_prepare before insert or update on public.documentos
for each row execute function private.kardex_prepare_row();

create function private.kardex_set_counters(req_number bigint, doc_number bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.kardex_has_access(true) then
    raise exception 'Solo el administrador puede restablecer correlativos' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(1170196,1);
  update private.kardex_contadores set valor=req_number where nombre='req';
  update private.kardex_contadores set valor=doc_number where nombre='doc';
end;
$$;
revoke all on function private.kardex_set_counters(bigint,bigint) from public, anon;
grant execute on function private.kardex_set_counters(bigint,bigint) to authenticated;

create function public.kardex_access() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('allowed',private.kardex_has_access(false),'is_admin',private.kardex_has_access(true));
$$;
create function public.kardex_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'requerimientos',coalesce((select jsonb_agg(r order by r.created_at,r.id) from public.requerimientos r),'[]'::jsonb),
    'documentos',coalesce((select jsonb_agg(d order by d.created_at,d.id) from public.documentos d),'[]'::jsonb)
  );
$$;

-- PostgREST runs an RPC in one transaction: validation failures roll back both tables and counters.
create function public.kardex_import(requerimientos_data jsonb, documentos_data jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  req_count integer;
  doc_count integer;
  req_max bigint;
  doc_max bigint;
begin
  if not private.kardex_has_access(true) then raise exception 'Solo el administrador puede importar' using errcode='42501'; end if;
  if jsonb_typeof(requerimientos_data) is distinct from 'array' or jsonb_typeof(documentos_data) is distinct from 'array' then
    raise exception 'Los datos deben ser arreglos JSON';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(1170196,1);
  perform set_config('kardex.importing','on',true);
  delete from public.documentos;
  delete from public.requerimientos;
  insert into public.requerimientos(id,numero,tipo,fecha_solicitud,cantidad_cajas,numeros_cargo,fecha_recepcion,fecha_devolucion,usuario)
  select id,numero,tipo,fecha_solicitud,cantidad_cajas,coalesce(numeros_cargo,''),fecha_recepcion,fecha_devolucion,usuario
  from jsonb_to_recordset(requerimientos_data) as r(
    id uuid,numero text,tipo text,fecha_solicitud date,cantidad_cajas integer,numeros_cargo text,
    fecha_recepcion date,fecha_devolucion date,usuario text
  );
  get diagnostics req_count = row_count;
  insert into public.documentos(id,kardex,fecha_registro,tipo_doc,periodo,ubicacion,folios,cargos,caja_asignada,f_envio,sustento,sustento_imagen,usuario,facturas,obs)
  select id,kardex,fecha_registro,tipo_doc,periodo,ubicacion,folios,coalesce(cargos,'{}'),caja_asignada,f_envio,
    coalesce(sustento,''),coalesce(sustento_imagen,''),usuario,coalesce(facturas,''),coalesce(obs,'')
  from jsonb_to_recordset(documentos_data) as d(
    id uuid,kardex text,fecha_registro date,tipo_doc text,periodo date,ubicacion text,folios integer,cargos text[],
    caja_asignada uuid,f_envio date,sustento text,sustento_imagen text,usuario text,facturas text,obs text
  );
  get diagnostics doc_count = row_count;
  select coalesce(max(substring(numero from 5)::bigint),0) into req_max from public.requerimientos;
  select coalesce(max(substring(kardex from 4)::bigint),0) into doc_max from public.documentos;
  perform private.kardex_set_counters(req_max,doc_max);
  perform set_config('kardex.importing','off',true);
  return jsonb_build_object('requerimientos',req_count,'documentos',doc_count,'req_counter',req_max,'doc_counter',doc_max);
end;
$$;
create function public.kardex_reset() returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  if not private.kardex_has_access(true) then raise exception 'Solo el administrador puede restablecer' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(1170196,1);
  delete from public.documentos;
  delete from public.requerimientos;
  perform private.kardex_set_counters(0,0);
  return jsonb_build_object('requerimientos',0,'documentos',0);
end;
$$;
revoke all on function public.kardex_access(),public.kardex_snapshot(),
  public.kardex_import(jsonb,jsonb),public.kardex_reset() from public,anon;
grant execute on function public.kardex_access(),public.kardex_snapshot(),
  public.kardex_import(jsonb,jsonb),public.kardex_reset() to authenticated;

-- Default replica identity exposes only primary keys on deletes. Clients reload an RLS-protected snapshot.
do $$
begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;
alter publication supabase_realtime add table public.requerimientos,public.documentos;
