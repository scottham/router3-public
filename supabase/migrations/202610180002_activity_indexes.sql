-- Console request log and usage chart: the signed-in user's own calls by time,
-- and the usage evidence for each request. Indexes only; no data changes.
create index if not exists model_requests_owner_created_idx
  on private.model_requests(owner_app_user_id, created_at desc, id desc)
  where owner_app_user_id is not null;
create index if not exists usage_events_request_idx
  on private.usage_events(request_id);
