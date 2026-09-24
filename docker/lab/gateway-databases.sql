-- The other gateways' databases.
--
-- `POSTGRES_DB` creates exactly one, and two gateways sharing a schema would be one
-- gateway wearing two names: the same peers table, the same identity, the same
-- catalogue. Run once, on the server's first boot.
CREATE DATABASE gateway_remote OWNER mcs;

-- A third, and it is not a spare: `FRIEND_OF_FRIEND` is a trust level the code makes
-- decisions on — what a catalogue shows, whether a relay is offered — and it cannot
-- exist with two gateways. Somebody introduced by a friend is a third party by
-- definition, so proving that behaviour needs a third party.
CREATE DATABASE gateway_far OWNER mcs;
