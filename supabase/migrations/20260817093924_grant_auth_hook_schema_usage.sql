-- Supabase Auth executes app.custom_access_token_hook as supabase_auth_admin.
-- EXECUTE on the function is not enough unless the role can also resolve the
-- containing schema.
grant usage on schema app to supabase_auth_admin;
