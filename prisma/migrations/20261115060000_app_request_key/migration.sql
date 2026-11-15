-- An app added by its link can carry a request key (game "Add your own app"): the same key from the same person is the same
-- request, so a retry after the sheet's wait answers the first app instead of making a second. The key is optional, so every
-- app made before, or without one, has none; the database allows many of those (a NULL is never equal to another).
ALTER TABLE "app_connections" ADD COLUMN "request_key" VARCHAR(200);

CREATE UNIQUE INDEX "app_connections_owner_id_request_key_key" ON "app_connections"("owner_id", "request_key");
