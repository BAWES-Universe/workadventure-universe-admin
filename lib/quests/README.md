# Quest copy (vendored from the game)

The `quest-copy.<locale>.json` files are the player strings of the game's `quest` namespace
(`play/src/i18n/<locale>/quest.ts` in the game repository). The game is the only source for these words: Orbit's
quest preview renders the invitation, the options and the payoff from these files and never types a player string
itself, so what an owner previews is what a visitor reads.

Do not edit the JSON by hand. To refresh it after the game's copy changes:

```sh
# in the game repository
cd play && npm run export-quest-copy
# then, from this repository's root
cp <game>/play/dist-quest-copy/quest-copy.*.json lib/quests/
npx jest __tests__/lib/quests-copy.test.ts
```

The test fails when a key the preview uses (`QUEST_COPY_KEYS` in `copy.ts`) is missing from any locale, so a renamed
or removed game string is caught here rather than on screen.

Format: flat keys, `{name}` parameters, and typesafe-i18n plurals (`{{s}}` or `{{one|other}}`) that follow the number
before them.
