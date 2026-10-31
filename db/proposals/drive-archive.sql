-- PROPOSAL ONLY. Apply to an isolated database first. NOT applied to production.
-- No UPDATE/DELETE on existing documents; no index removal or source cleanup.
create table public.kardex_drive_jobs (
 id uuid primary key,
 document_id uuid references public.documentos(id),
 idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
 data jsonb not null check (document_id is not null or data->>'category' in ('backups','manifests')) check (data->>'status' in ('pending','uploading','uploaded','verified','attention')),
 lease_owner uuid,
 lease_expires_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index kardex_drive_jobs_document_idx on public.kardex_drive_jobs(document_id);
alter table public.kardex_drive_jobs enable row level security;
revoke all on public.kardex_drive_jobs from public,anon,authenticated,service_role;
grant select,insert,update on public.kardex_drive_jobs to service_role;

create function public.kardex_drive_claim(p_id uuid,p_owner uuid) returns jsonb
language sql security invoker set search_path='' as $$
 update public.kardex_drive_jobs set lease_owner=p_owner,
 lease_expires_at=now()+interval '180 seconds',updated_at=now()
 where id=p_id and (lease_owner is null or lease_expires_at<now())
 returning to_jsonb(kardex_drive_jobs.*);
$$;
create function public.kardex_drive_save(p_id uuid,p_owner uuid,p_patch jsonb,p_release boolean default true) returns jsonb
language sql security invoker set search_path='' as $$
 update public.kardex_drive_jobs set data=data||p_patch,updated_at=now(),
 lease_owner=case when p_release then null else lease_owner end,
 lease_expires_at=case when p_release then null else now()+interval '180 seconds' end
 where id=p_id and lease_owner=p_owner and lease_expires_at>now()
 returning to_jsonb(kardex_drive_jobs.*);
$$;
revoke all on function public.kardex_drive_claim(uuid,uuid) from public,anon,authenticated;
revoke all on function public.kardex_drive_save(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.kardex_drive_claim(uuid,uuid) to service_role;
grant execute on function public.kardex_drive_save(uuid,uuid,jsonb,boolean) to service_role;
