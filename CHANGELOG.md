# Changelog

All notable changes to Orbit are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers match the [GitHub releases](https://github.com/BAWES-Universe/workadventure-universe-admin/releases), where every release also lists each pull request in full.

Orbit and the Universe game ([workadventure-universe](https://github.com/BAWES-Universe/workadventure-universe)) are released together; see the game's changelog for the other half.

## [Unreleased]

Planned for 0.5.0. This section gets its version and date when the release ships. Numbers like (#123) are pull request numbers in this repository.

### Added
- **Bricks for everyone.** A bot with no room, "Just you" for what a bot makes, replies in a group that only use what all of them may open, one Brick for everyone, more Bricks, delete with Undo, the Brick for guests, what a Brick remembers and its files, an owner changes a Brick's look, Mind, voice, behavior and permissions, the Call rule, Bricks that live in a room and visit, Brick templates. (#911 to #918, #924, #926, #927, #929, #931, #933, #948, #951)
- **Apps.** One name, Apps. Connect an App once and let chosen Bricks use it, ready-made Apps, lend an App to a universe, Keys for Apps, add by link without making it twice, name the field when a key has text that cannot be sent, choose what each App runs on, the use and demand page, Composio metering at real rates, Connect GitHub, Chat Connect offers that include ready-made Apps and GitHub, and the bot server is told what an App shared through a Brick covers, with the owner told once at the limit. (#920, #925, #928, #935, #940, #941, #943 to #945, #949, #952, #954, #959, #985, #992)
- **Goals and tasks.** Universe's own scheduler, reminders end to end, watches, briefings and goals, screens and "Everything Brick did", ask once when unsure, cards that wait, runs tied to the meter, a step starts only while the goal is going, other people can ask a Brick for a job, Run now, and snooze one run without moving the schedule. (#922, #930, #932, #934, #936 to #939, #950, #953, #960, #996)
- **Computers.** Real computers for Bricks: a Brick's computer, its jobs and hand-over, provider, job keys, broker, fence and machine image, plus fixes from the first real-machine runs. Computers report back truthfully: told only when delivered, results kept in one shared place, file cards, a direct message after a visit, and Files paging. Git from computers, fencing, spend caps, cost controls, give-back, purge, Pause now and a page-visit record. (#921, #946, #964, #965, #981, #988)
- **Usage, paying and funding.** The meter's books, usage for people and costs for us, funding books, chat rules and task receipts, grants screen, gifts and credit limits, a bounded Instant executor, the Instant credit door, Instant runs carry their task, and launch Limits, a rollout budget and default grants are seeded. (#919, #923, #955 to #958, #961 to #963, #979)
- **Voice notes.** Every bot hears voice notes, with limits, reservations, turns and cleanup. (#942)
- **Someone who met a Brick keeps their direct message** after a visit ends, until the owner takes them off. (#993, shipped inside #988)
- **Locked phone push.** A Brick that speaks by itself shows its news as the title. (#966)

### Changed
- Own voice keys list the models the company itself lists for the key, models can be loaded again on a saved key, and talking live reads Google's and OpenAI's own model lists. (#897, #898, #900)
- Every pending invitation is shown to everyone who may invite. (#902)
- Universe cards no longer say "By owner", and old images are cleaned up weekly. (#1001)
- Placing a Brick again where it already stands keeps how it behaves. (#1007)
- Free greetings are never counted. (#911)
- A task being looked up ends by itself, "Didn't work?" is removed, and Apps tasks that came to nothing are hidden in Activity. (#967, #968)
- The game gets Orbit's own user id in PostHog, never the email. (#831, #947)
- The Docker build no longer runs out of memory. (#964)

## [0.3.44] - 2026-11-09

### Added
- Every Pipecat voice company can be added as a key, and voice models fill in on their own from each key.

### Fixed
- Voice screens: a failed model list is asked for again soon, and the starting voice for Groq and Sarvam is dropped when the starting model changes.

## [0.3.43] - 2026-11-08

### Added
- Voice reaches the bot: new bots start on Universe AI's current voice models, and a bot's voice switch is sent to the bot server.
- More voice companies as keys (Fish Audio, Cartesia, Deepgram, ElevenLabs, Soniox, AssemblyAI) and one key that listens and speaks.
- Talking models that listen and speak in one: OpenAI, xAI, Azure OpenAI, Google, AWS, Inworld, Ultravox and Zoom.
- Your own speech server, reached with an https address.

## [0.3.42] - 2026-11-05

### Added
- Expired sign-ins are shown, say who connected them, and can be reconnected from Orbit home.
- Pass a whole universe to another account: offer, then accept.

## [0.3.41] - 2026-11-05

### Added
- Voice keys and limits, the Universe AI voice page, and voice replies counted inside the Universe AI allowance.
- Bots ask first: approvals page, allow-more times per bot, and who is allowed more now.
- A bot only sees its own artifacts, and another bot's only when pointed at.

### Fixed
- Emails are kept out of member and invitation answers.

## [0.3.40] - 2026-10-31

### Added
- Bots ask before changing things: roles for "Have bots change things" and "Have bots delete or send", and a saved record of each bot action that waits for a tap.
- Voice settings and personal voice keys: add a key and lend it to a universe.

## [0.3.39] - 2026-10-29

### Added
- Kept nearby items remember who they were shared with, and list by person.

### Fixed
- The shared artifact page has ink behind it, with no light strip on phones.

## Earlier releases

Releases before 0.3.39 are listed on the [GitHub releases page](https://github.com/BAWES-Universe/workadventure-universe-admin/releases).

[Unreleased]: https://github.com/BAWES-Universe/workadventure-universe-admin/compare/v0.3.44...develop
[0.3.44]: https://github.com/BAWES-Universe/workadventure-universe-admin/compare/v0.3.43...v0.3.44
[0.3.43]: https://github.com/BAWES-Universe/workadventure-universe-admin/compare/v0.3.42...v0.3.43
[0.3.42]: https://github.com/BAWES-Universe/workadventure-universe-admin/compare/v0.3.41...v0.3.42
[0.3.41]: https://github.com/BAWES-Universe/workadventure-universe-admin/compare/v0.3.40...v0.3.41
[0.3.40]: https://github.com/BAWES-Universe/workadventure-universe-admin/compare/v0.3.39...v0.3.40
[0.3.39]: https://github.com/BAWES-Universe/workadventure-universe-admin/compare/v0.3.38...v0.3.39
