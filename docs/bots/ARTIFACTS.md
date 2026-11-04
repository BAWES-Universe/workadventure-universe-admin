# Live artifacts (game #1422, Orbit #622)

Bots make mini apps, pages, Markdown documents and SVG drawings for the person who asked. Orbit keeps the list, every
version and who may open or change each one. This page is the contract for the bot server (make, change, read) and the
game (open, versions, code, share, restore, copy, delete).

## Rules

- **Owner:** the person who asked. The bot is its maker (id and the name it had). A guest owns nothing: what a guest asks
  for is kept for a day from its last change, and anyone in that chat may change it meanwhile.
- **Who can open it** (`openScope`): `chat` (people in the chat it was made in, the default) or `link` (anyone with the
  link). The owner always can. Someone who may not open it hears `404`, the same as for an artifact that does not exist.
- **Who can ask for changes** (`changeScope`): `owner` (the default) or `openers` (everyone who can open it, in the chat
  it was made in). The owner may ask in any chat they have with a bot; nobody else asks from another chat.
- **One bot's work is not another bot's context (game #1781, Orbit #790):** by id, a bot reaches the artifacts made in the
  chat it is in, and the owner's artifacts this bot made (`makerBotId`) in any chat. Another bot's artifact in another
  chat is reached only when the call lists its id in `referencedArtifactIds`, which the bot server fills from what the
  person themselves wrote (a pasted artifact link, or a card they replied to), never from what a bot or a tool result
  mentioned. Anything else answers `404 not_found`, as for an artifact that is not there. The rules above still apply on
  top: a pasted link opens someone else's artifact only when its owner shared it by link, and changes stay with the chat it
  was made in. The search over files and the in-chat list show the same: this chat's, and what this bot made for the person.
- **Versions:** every change is a new version with what changed and who asked. Nothing is overwritten. Restore makes a
  new version out of an old one. Up to 200 versions; one version is up to 512 KB.
- **Make a copy:** the signed-in viewer's own artifact (version 1 = the version they pick), in no chat, so only they open
  it until they share it. The file is copied, so deleting the original leaves the copy whole.
- **Bot access and telemetry:** make, change and read first ask the same rules as `/api/bots/:id/access` (nearby chat for
  a `nearby` chat, direct message for a `dm` chat). The answer carries `hidden`, the Bot chat telemetry switch for that
  bot: when `true` the bot server keeps the artifact's text out of PostHog and Sentry. Orbit logs no content.
- **Files:** one folder per version in the artifacts bucket (below), under a name with a random part:
  `artifacts/<id>/v<n>-<random>/index.html`. Orbit is the only writer. The bot server sends text; it needs no bucket
  keys. Versions saved before game #1510 keep their old key (`v<n>-<random>.html`, no folder).
- **Media (game #1510):** a page or mini app can carry songs, images and videos from the chat. They sit beside the page
  in its folder, so the page names them as is (`<audio src="song.mp3" controls>`), and a shared link plays them too.
  Only audio, raster image and video types, under a plain name (letters, digits, `.`, `-`, `_`) whose ending matches the
  type. The files one save adds fit together in the super admin's "Media added in one save" limit (`artifacts.media`,
  in MB, recommended 50; 0 lets none in). It keeps one upload from filling the bot server's or Orbit's memory; media a
  version keeps from the one before doesn't count, since it is copied inside the bucket. A make or change that adds files
  may leave at most "Files in one artifact" (`artifacts.mediaFiles`, recommended 50, Orbit #696) on the version; one
  already over a lowered limit can still be edited, replace a file or drop some. A change keeps the media it had unless `dropMedia` names them; restore and copy
  bring the media of that version; delete and the guest clean-up remove them. The bot hears each version's
  `media: [{ name, contentType, sizeBytes }]`, never where they are stored.

## Bot server routes (`BOT_SERVICE_TOKEN`; the admin token also works)

Every body carries `botId`, `person` (`{ signedIn, identifier?, name? }`: the identifier is their WorkAdventure uuid or
email, and is required when signed in) and `chat` (`{ kind: "nearby" | "dm", ref }`: the id the bot server and the game
both use for that chat; a viewer is "in the chat" when the game says so for the same `ref`).

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/artifacts` | `title`, `kind` (`app`, `page`, `markdown`, `svg`), `content`, `summary?` | `{ artifact, version, hidden }` |
| `POST /api/artifacts/:id/change` | `edits: [{ old, new, all? }]` **or** `content`; `summary?`, `title?`, `baseVersion?`, `dropMedia?`, `referencedArtifactIds?` (up to 20) | `{ artifact, version, hidden }` |
| `POST /api/artifacts/:id/read` | `version?` (the latest by default), `referencedArtifactIds?` (up to 20) | `{ artifact, version, content, hidden }` |
| `POST /api/artifacts/in-chat` | none beyond the three above | `{ artifacts, hidden }`: what was made in this chat that the person may open, plus the artifacts this bot made for the person in their other chats; this chat's come first, then the others, each group newest change first (up to 20 in all) |

**With media:** send `multipart/form-data` to `POST /api/artifacts` or `POST /api/artifacts/:id/change`: the same JSON
as a `request` part, and one `media` part per file, its file name being the name the page uses. A change may send only
media (or only `dropMedia`) and no edits; the page stays as it was. Too much answers `413 media_too_large` (`media_off`
when the limit is 0); a wrong name or type answers `422` (`invalid_media_name`, `media_type_not_allowed`,
`media_type_mismatch`, `media_not_allowed` for a document or drawing, `duplicate_media`, `empty_media`,
`media_not_found` for a dropped name that is not there, `too_many_media_files` when the save would leave more files than
"Files in one artifact" allows, with both numbers in the message).

**A change by another bot makes a copy.** When the calling bot is not the artifact's maker (`makerBotId`), the original is left exactly as it was (no new version, no new title) and the answer is a **new artifact**: made by the calling bot for the person who asked, in the chat the call came from, with `copiedFromId` set to the original, version 1 being the original's latest text and media with the change applied (summary "Copy of version N, changed" unless the bot sent one). It starts shared with its chat only, whatever the original's sharing; the bot's next change to it is an ordinary new version. The same edits, `baseVersion`, size and media rules apply (`baseVersion` is checked against the original); the original's version limit does not, since the copy starts at version 1. A bot sees that it happened by `artifact.id` in the answer differing from the id it sent.

Edits are applied in order, each on the result of the one before. An edit whose `old` is not in the file (`422
edit_not_found`) or appears more than once without `all` (`422 edit_ambiguous`) changes nothing; the message names the
edit. `baseVersion` is the version the bot read: a newer one in between answers `409 stale_version`, and so does a second
change made on the same version at the same moment.

## Game routes (`ADMIN_API_TOKEN`)

Bodies carry `viewer: { person, inChat, chat }`: `inChat` says the person is in `chat` right now (the game vouches), and counts only when `chat` is the chat the artifact was made in. An artifact belongs to the person who asked, and a bot acts for the person talking to it: any bot in the chat may read it for the owner, or for someone in that chat when the owner allowed it, whichever bot made it. A bot that did not make it never writes into it (Orbit #800): its change is made on a copy of its own (below). Outside that chat a bot reaches only what it made, or what the person pointed at (`referencedArtifactIds`, above). A bot never acts on its own across people or chats.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/artifacts/mine` | `person` | `{ artifacts }` the person owns, newest change first |
| `POST /api/artifacts/:id/open` | `viewer`, `version?` | `{ artifact, version: { number, summary, askedByName, sizeBytes, createdAt, url }, you }` |
| `POST /api/artifacts/:id/versions` | `viewer` | `{ versions }`, newest first |
| `POST /api/artifacts/:id/versions/:number` | `viewer` | `{ version, content }` (the Code view) |
| `PUT /api/artifacts/:id/share` | `viewer`, `openScope?`, `changeScope?` | `{ artifact }`; owner only (`403` for others who can open it) |
| `POST /api/artifacts/:id/restore` | `viewer`, `number` | `{ artifact, version, you }`; owner only |
| `POST /api/artifacts/:id/copy` | `viewer`, `version?` | `{ artifact, version, you }`; `403 sign_in_required` for a guest |
| `DELETE /api/artifacts/:id` | `viewer` | `{ deleted: true }`; owner only. Removes every version and file; a copy keeps its own files |

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
