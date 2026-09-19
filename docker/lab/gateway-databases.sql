-- The second gateway's database.
--
-- `POSTGRES_DB` creates exactly one, and two gateways sharing a schema would be one
-- gateway wearing two names: the same peers table, the same identity, the same
-- catalogue. Run once, on the server's first boot.
CREATE DATABASE gateway_remote OWNER mcs;
