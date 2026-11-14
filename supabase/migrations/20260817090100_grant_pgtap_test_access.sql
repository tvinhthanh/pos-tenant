-- Supabase linked pgTAP tests run through a temporary database role.
-- Grant schema/function access so the runner can call extensions.plan/ok/is/finish.
grant usage on schema extensions to public;
grant execute on all functions in schema extensions to public;

