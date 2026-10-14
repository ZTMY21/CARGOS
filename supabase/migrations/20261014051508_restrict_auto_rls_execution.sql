-- The platform's automatic RLS event trigger is internal, not a client RPC.
-- Keep its owner and event-trigger behavior; remove client execution privileges.
do $hardening$
begin
  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$hardening$;
