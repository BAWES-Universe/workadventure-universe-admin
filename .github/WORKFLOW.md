# How work moves through GitHub

GitHub issues are the one list of work for Universe, across the game repo
(BAWES-Universe/workadventure-universe) and Orbit (BAWES-Universe/workadventure-universe-admin).
Mocks stay as Artifact pages. Each one is linked from its issue.

## Labels

Each open issue has one state label:

| Label | Meaning |
|---|---|
| `needs-review` | Old or unclear. Khalid reviews it. Nothing gets closed without his word. |
| `approved` | Khalid said yes. The issue quotes his words with the time and where he said it. |
| `needs-mock` | It changes what people see, so a mock is approved first. |
| `on-hold` | Khalid parked it. |
| `on-dev` | Merged into the dev branch, waiting for the next release. |
| `next-release` | Khalid picked it for the next release. |

Area labels such as `chat`, `bots`, `security` and `map-editor` sit alongside the state label.

## Steps

1. **Approval becomes an issue.** When Khalid says yes, or we say we'll do something later, the issue
   is written or updated in the same turn: his words, the time (Kuwait), where he said it, the mock
   link, the code evidence and "Done when".
2. **Khalid picks issues.** A thread or agent starts with those issue numbers as its brief.
3. **One PR per issue, into the dev branch** (`universe-develop` for the game, `develop` for Orbit).
   The PR body starts with `Closes #N` (in the other repo: `Closes BAWES-Universe/<repo>#N`) and
   links the mock. The design check compares the PR with that mock.
4. **Merged into dev.** The issue gets `on-dev` and a comment naming the PR.
5. **Release.** The release PR from the dev branch to prod lists `Closes #N` for every issue in it.
   GitHub closes them when the release merges. This step is needed because both repos' default
   branch is prod, so a PR into the dev branch can't close an issue on its own.
6. **Nothing "later" is lost.** Anything deferred becomes an `on-hold` issue in the same turn.

Work that spans both repos has one issue, in the repo that carries most of it. The other repo's PR
links to it.

An issue is closed only by a merged release or by Khalid's word, never just to tidy up.
