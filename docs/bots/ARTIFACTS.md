# Live artifacts (game #1422, Orbit #622)

Bots make mini apps, pages, Markdown documents and SVG drawings for the person who asked. Orbit keeps the list, every
version and who may open or change each one. This page is the contract for the bot server (make, change, read) and the
game (open, versions, code, share, restore, copy).

## Rules

- **Owner:** the person who asked. The bot is its maker (id and the name it had). A guest owns nothing: what a guest asks
  for is kept for a day from its last change, and anyone in that chat may change it meanwhile.
- **Who can open it** (`openScope`): `chat` (people in the chat it was made in, the default) or `link` (anyone with the
  link). The owner always can. Someone who may not open it hears `404`, the same as for an artifact that does not exist.
- **Who can ask for changes** (`changeScope`): `owner` (the default) or `openers` (everyone who can open it, in the chat
  it was made in). The owner may ask in any chat they have with a bot; nobody else asks from another chat.
- **Versions:** every change is a new version with what changed and who asked. Nothing is overwritten. Restore makes a
  new version out of an old one. Up to 200 versions; one version is up to 512 KB.
- **Make a copy:** the signed-in viewer's own artifact (version 1 = the version they pick), in no chat, so only they open
  it until they share it. The file is copied, so deleting the original leaves the copy whole.
- **Bot access and telemetry:** make, change and read first ask the same rules as `/api/bots/:id/access` (nearby chat for
  a `nearby` chat, direct message for a `dm` chat). The answer carries `hidden`, the Bot chat telemetry switch for that
  bot: when `true` the bot server keeps the artifact's text out of PostHog and Sentry. Orbit logs no content.
- **Files:** one file per version in the artifacts bucket (below), under a name with a random part. Orbit is the only
  writer. The bot server sends text; it needs no bucket keys.

## Bot server routes (`BOT_SERVICE_TOKEN`; the admin token also works)

Every body carries `botId`, `person` (`{ signedIn, identifier?, name? }`: the identifier is their WorkAdventure uuid or
email, and is required when signed in) and `chat` (`{ kind: "nearby" | "dm", ref }`: the id the bot server and the game
both use for that chat; a viewer is "in the chat" when the game says so for the same `ref`).

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/artifacts` | `title`, `kind` (`app`, `page`, `markdown`, `svg`), `content`, `summary?` | `{ artifact, version, hidden }` |
| `POST /api/artifacts/:id/change` | `edits: [{ old, new, all? }]` **or** `content`; `summary?`, `title?`, `baseVersion?` | `{ artifact, version, hidden }` |
| `POST /api/artifacts/:id/read` | `version?` (the latest by default) | `{ artifact, version, content, hidden }` |
| `POST /api/artifacts/in-chat` | none beyond the three above | `{ artifacts, hidden }`: what was made in this chat that the person may open, newest change first (up to 20) |

Edits are applied in order, each on the result of the one before. An edit whose `old` is not in the file (`422
edit_not_found`) or appears more than once without `all` (`422 edit_ambiguous`) changes nothing; the message names the
edit. `baseVersion` is the version the bot read: a newer one in between answers `409 stale_version`, and so does a second
change made on the same version at the same moment.

## Game routes (`ADMIN_API_TOKEN`)

Bodies carry `viewer: { person, inChat, chat }`: `inChat` says the person is in `chat` right now (the game vouches), and counts only when `chat` is the chat the artifact was made in. A bot reads, changes and lists only what it made (a copy the owner made goes to any bot they bring it to).

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/artifacts/mine` | `person` | `{ artifacts }` the person owns, newest change first |
| `POST /api/artifacts/:id/open` | `viewer`, `version?` | `{ artifact, version: { number, summary, askedByName, sizeBytes, createdAt, url }, you }` |
| `POST /api/artifacts/:id/versions` | `viewer` | `{ versions }`, newest first |
| `POST /api/artifacts/:id/versions/:number` | `viewer` | `{ version, content }` (the Code view) |
| `PUT /api/artifacts/:id/share` | `viewer`, `openScope?`, `changeScope?` | `{ artifact }`; owner only (`403` for others who can open it) |
| `POST /api/artifacts/:id/restore` | `viewer`, `number` | `{ artifact, version, you }`; owner only |
| `POST /api/artifacts/:id/copy` | `viewer`, `version?` | `{ artifact, version, you }`; `403 sign_in_required` for a guest |

`you` is `{ owner, change, manage, copy }`: whether to show Ask-to-change, Share and Restore, and Make a copy.
`version.url` is where the file is served from, for the locked box.

## Storage (Orbit environment)

Without these every route answers `503 storage_not_configured` and nothing else in Orbit notices.

| Variable | What |
| --- | --- |
| `ARTIFACTS_S3_BUCKET`, `ARTIFACTS_S3_ENDPOINT` | The bucket (R2) and its S3 endpoint |
| `ARTIFACTS_S3_ACCESS_KEY_ID`, `ARTIFACTS_S3_SECRET_ACCESS_KEY` | A key that can read, write and delete in that bucket |
| `ARTIFACTS_S3_REGION` | `auto` for R2 (the default) |
| `ARTIFACTS_PUBLIC_URL` | The address the bucket is served from. It must **not** be under bawes.net, so a running page can never reach the sign-in or the game |

The bucket needs no listing. File names carry a random part, so a link to a version cannot be guessed from the artifact
id; "people in this chat" is enforced by Orbit's open route, which is the only place that hands out the address.
