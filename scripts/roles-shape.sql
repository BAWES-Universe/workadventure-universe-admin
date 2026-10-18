-- Orbit roles (#314): the shape of prod's members, tags and invitations (every status), as counts only.
-- Read-only: it runs in a READ ONLY transaction and ends with ROLLBACK. It prints one line of JSON.
-- It checks itself: "complete" is true only when every world member row and every invitation is in the output.
-- No ids, names, emails or slugs: universes and worlds are numbers (1, 2, 3...), and every tag other than
-- admin, editor, member and everyone is shown as c1, c2... (numbered per universe, the same tag gets the same number).
BEGIN TRANSACTION READ ONLY;

WITH u AS (
  SELECT id, is_public, owner_id, row_number() OVER (ORDER BY created_at, id) AS un FROM universes
), w AS (
  SELECT id, universe_id, is_public, row_number() OVER (PARTITION BY universe_id ORDER BY created_at, id) AS wn FROM worlds
), custom AS (
  SELECT universe_id, tag, dense_rank() OVER (PARTITION BY universe_id ORDER BY tag) AS cn FROM (
    SELECT w.universe_id, t.tag FROM world_members m JOIN worlds w ON w.id = m.world_id CROSS JOIN LATERAL unnest(m.tags) AS t(tag)
    UNION
    SELECT w.universe_id, t.tag FROM membership_invitations i JOIN worlds w ON w.id = i.world_id CROSS JOIN LATERAL unnest(i.tags) AS t(tag)
  ) AS x
  WHERE tag NOT IN ('admin', 'editor', 'member', 'everyone')
), member_rows AS (
  SELECT m.user_id, w.universe_id, w.wn,
    ARRAY(
      SELECT CASE WHEN t.tag IN ('admin', 'editor', 'member', 'everyone') THEN t.tag ELSE 'c' || c.cn END
      FROM unnest(m.tags) WITH ORDINALITY AS t(tag, n)
      LEFT JOIN custom c ON c.universe_id = w.universe_id AND c.tag = t.tag
      ORDER BY t.n
    ) AS tags
  FROM world_members m JOIN w ON w.id = m.world_id
), people AS (
  SELECT r.universe_id, r.user_id = u.owner_id AS owner,
    jsonb_agg(jsonb_build_object('w', r.wn, 'tags', to_jsonb(r.tags)) ORDER BY r.wn) AS worlds
  FROM member_rows r JOIN u ON u.id = r.universe_id
  GROUP BY r.universe_id, r.user_id, u.owner_id
), invitations AS (
  SELECT w.universe_id, w.wn, i.status,
    ARRAY(
      SELECT CASE WHEN t.tag IN ('admin', 'editor', 'member', 'everyone') THEN t.tag ELSE 'c' || c.cn END
      FROM unnest(i.tags) WITH ORDINALITY AS t(tag, n)
      LEFT JOIN custom c ON c.universe_id = w.universe_id AND c.tag = t.tag
      ORDER BY t.n
    ) AS tags
  FROM membership_invitations i JOIN w ON w.id = i.world_id
), shown AS (
  SELECT (SELECT count(*) FROM member_rows r JOIN u ON u.id = r.universe_id) AS member_rows,
    (SELECT count(*) FROM invitations i JOIN u ON u.id = i.universe_id) AS invitations,
    (SELECT count(*) FROM world_members) AS member_rows_all,
    (SELECT count(*) FROM membership_invitations) AS invitations_all
)
SELECT jsonb_build_object(
  'totals', jsonb_build_object(
    'universes', (SELECT count(*) FROM universes),
    'worlds', (SELECT count(*) FROM worlds),
    'rooms', (SELECT count(*) FROM rooms),
    'world_members', (SELECT count(*) FROM world_members),
    'invitations', (SELECT count(*) FROM membership_invitations),
    'invitations_by_status', (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*) AS n FROM membership_invitations GROUP BY status) AS s),
    'roles_table_exists', to_regclass('public.roles') IS NOT NULL
  ),
  'shown', (SELECT jsonb_build_object('world_members', member_rows, 'invitations', invitations) FROM shown),
  'complete', (SELECT member_rows = member_rows_all AND invitations = invitations_all FROM shown),
  'universes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'u', u.un, 'public', u.is_public,
      'worlds', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'w', w.wn, 'public', w.is_public,
          'public_rooms', (SELECT count(*) FROM rooms r WHERE r.world_id = w.id AND r.is_public),
          'private_rooms', (SELECT count(*) FROM rooms r WHERE r.world_id = w.id AND NOT r.is_public)
        ) ORDER BY w.wn), '[]') FROM w WHERE w.universe_id = u.id)
    ) ORDER BY u.un), '[]') FROM u),
  'people', (SELECT coalesce(jsonb_agg(jsonb_build_object('u', g.un, 'owner', g.owner, 'worlds', g.worlds, 'count', g.n) ORDER BY g.un, g.n DESC, g.owner, g.worlds::text), '[]')
    FROM (SELECT u.un, p.owner, p.worlds, count(*) AS n FROM people p JOIN u ON u.id = p.universe_id GROUP BY u.un, p.owner, p.worlds) AS g),
  'invitations', (SELECT coalesce(jsonb_agg(jsonb_build_object('u', g.un, 'w', g.wn, 'status', g.status, 'tags', to_jsonb(g.tags), 'count', g.n) ORDER BY g.un, g.wn, g.status, g.tags::text), '[]')
    FROM (SELECT u.un, i.wn, i.status, i.tags, count(*) AS n FROM invitations i JOIN u ON u.id = i.universe_id GROUP BY u.un, i.wn, i.status, i.tags) AS g)
);

ROLLBACK;
