-- docs/simulator-beacon.md 6: the wmsfo_sim_ prefix on the sql.md 12 recipe.
-- Runs once on an empty data volume for local development.
create role wmsfo_sim_migrate_dev login password 'wmsfo_sim_migrate_dev' nosuperuser nocreatedb nocreaterole noinherit;
create role wmsfo_sim_app_dev     login password 'wmsfo_sim_app_dev'     nosuperuser nocreatedb nocreaterole noinherit;
create database wmsfo_sim_dev owner wmsfo_sim_migrate_dev encoding 'UTF8' template template0;
revoke all on database wmsfo_sim_dev from public;
grant connect on database wmsfo_sim_dev to wmsfo_sim_migrate_dev, wmsfo_sim_app_dev;

alter role wmsfo_sim_app_dev in database wmsfo_sim_dev set statement_timeout = '10s';
alter role wmsfo_sim_app_dev in database wmsfo_sim_dev set lock_timeout = '5s';
alter role wmsfo_sim_app_dev in database wmsfo_sim_dev set idle_in_transaction_session_timeout = '15s';
alter role wmsfo_sim_app_dev in database wmsfo_sim_dev set timezone = 'UTC';
alter role wmsfo_sim_migrate_dev in database wmsfo_sim_dev set statement_timeout = 0;
alter role wmsfo_sim_migrate_dev in database wmsfo_sim_dev set lock_timeout = '60s';
alter role wmsfo_sim_migrate_dev in database wmsfo_sim_dev set timezone = 'UTC';

\connect wmsfo_sim_dev wmsfo_sim_migrate_dev
revoke create on schema public from public;
grant usage on schema public to wmsfo_sim_app_dev;
alter default privileges for role wmsfo_sim_migrate_dev in schema public
  grant select, insert, update, delete on tables to wmsfo_sim_app_dev;
