# How work moves through GitHub

GitHub issues are the one list of work for Universe, across the game repo
(BAWES-Universe/workadventure-universe) and Orbit (BAWES-Universe/workadventure-universe-admin).
Mocks stay as Artifact pages. Each one is linked from its issue.

## What an issue is

One real problem or ask, written in the layout of the security issues: Problem, Who it affects,
Evidence, Proposed fix (with size), Done when, His words. Short, plain words, about 20 lines.

Not an issue: a bundle or checklist (split it, one issue each), an idea nobody asked for, a "check"
or review reminder, or something already built. Built things are closed as completed with links to
the PR and the issue. Things that aren't issues are closed as not planned with one factual line.

## Labels

Each open issue has one state label:

| Label | Meaning |
|---|---|
| `needs-review` | Old or unclear. Khalid reviews it. |
| `approved` | Khalid said yes. The issue quotes his words with the time (Kuwait). |
| `needs-mock` | It changes what people see, so a mock is approved first. |
| `on-hold` | Khalid parked it. |
| `on-dev` | Merged into the dev branch, waiting for the next release. |
| `next-release` | Khalid picked it for the next release. |

Area labels such as `chat`, `bots`, `security` and `map-editor` sit alongside the state label.

## Steps

1. **A request becomes an issue.** When Khalid asks for something, or we find a bug in code, the
   issue is written in the same turn with his words, the time (Kuwait), the code evidence and
   "Done when".
2. **Khalid picks issues.** A thread or agent starts with those issue numbers as its brief.
3. **One PR per issue, into the dev branch** (`universe-develop` for the game, `develop` for Orbit).
   The PR body starts with `Closes #N` (in the other repo: `Closes BAWES-Universe/<repo>#N`) and
   links the mock. The design check compares the PR with that mock.
4. **Merged into dev.** The issue is closed as completed with a comment linking the PR, and the PR
   gets a comment linking the issue.
5. **Release.** The release PR from the dev branch to prod lists `Closes #N` for every issue in it.
   Both repos' default branch is prod, so a PR into the dev branch can't close an issue on its own.
6. **Nothing "later" is lost.** Anything Khalid defers becomes an `on-hold` issue in the same turn.

Work that spans both repos has one issue, in the repo that carries most of it. The other repo's PR
links to it.
