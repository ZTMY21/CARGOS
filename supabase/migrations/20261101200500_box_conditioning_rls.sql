-- Defensa adicional para el registro privado de acondicionamiento.
-- Las operaciones se efectúan únicamente mediante funciones administrativas verificadas.
alter table private.box_conditioning enable row level security;
alter table private.box_conditioning_events enable row level security;
revoke all on private.box_conditioning from public,anon,authenticated;
revoke all on private.box_conditioning_events from public,anon,authenticated;
