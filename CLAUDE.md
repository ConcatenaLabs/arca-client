# Working on the Arca client

Notes for AI coding agents and new contributors: the conventions that are not
obvious from the code. `AGENTS.md` is a link to this file. [README.md](README.md)
says what the app is, how to run it and how it is laid out; read it first.

<!-- BEGIN SHARED AGENT CONVENTIONS: identical in every Sequentia repo. Change it in all of them together. -->
## Working with git and GitHub here

These rules are the same in every Sequentia repository. They are repeated in each
one because this file is the only thing an agent is guaranteed to read, whatever
machine it is working from.

**Nothing pushed to GitHub credits Claude, Anthropic, or any AI tool.** No
`Co-Authored-By: Claude` trailer, no `Claude-Session:` trailer or `claude.ai`
link, no "Generated with Claude Code" in a commit message or a pull request body,
no `claude/*` branch names or session ids, and no mention in source, comments,
docs or issue text. Agent tooling offers several of these by default; compose the
message without them rather than stripping them afterwards.

**Author every commit as the person the session is working for.** Several people
commit in these repositories and an agent always runs on behalf of one of them,
so derive the author from the authenticated GitHub account rather than from a
list of names that goes stale the moment somebody new arrives:

    git -c user.name="$(gh api user --jq '.name // .login')" \
        -c user.email="$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')" \
        commit ...

That address is the GitHub `noreply` form, which is what links a commit to its
account and keeps private addresses out of a public history. When `gh` is not
authenticated as the person the work belongs to, ask them instead of guessing.

**Never infer the author from `git log`.** The clones carry no `user.name` or
`user.email`, so `git commit` stops with "Author identity unknown" and the
nearest answer to hand is the author of the last commit — which is whoever
pushed last and says nothing about who is working now. Attributing a commit to
someone who did not write it puts their name on code they never reviewed, and
taking it back costs a history rewrite and a force-push over commits other
machines have already pulled.

**Every change lands through a pull request that you merge yourself, at once.**
There is no reviewer on this project; the pull request exists so the reasoning is
recorded beside the diff. Branch, push, open it, merge it, delete the branch, all
in one sitting. Pushing straight to the default branch is the rule most often
broken here, and it is the one that costs the record. A pull request stays open
only when the repository owner asks for that specific one, and that never carries
over to the next.

**Name branches `area/short-description`**: `fix/`, `doc/`, `feature/`, `test/`,
`build/`, or the component being changed. Never a tool name, a session id, or
`worktree-*`.

**Write the subject as `area: what changed`**, one line, 72 characters at the
outside and 50 where you can manage it. Put the reasoning in the body, and
explain why rather than what.

**These repositories are public and world-readable.** Never commit private keys,
seeds, `wallet.dat`, RPC credentials, `.env` files or API tokens. Read the diff
before every commit. Secrets belong on the server and in offline backups.

**A file belongs to the repository whose code it describes.** Decide which repo
owns it before writing it; if it landed in the wrong one, move it rather than
deleting it.

**Documentation is part of the change, not a follow-up.** A change that makes a
README, a doc page, a runbook or a code comment wrong is not finished until that
text is right again, in the same pull request as the code. Before you open the
pull request, search the repository for whatever you renamed, moved or removed —
the old binary name, the old path, the old flag, the old command — and fix every
hit. If the change falsifies another repository's documentation, that repository
gets its own pull request in the same sitting. A stale instruction costs a new
user more than a missing one: they trust it, run it, it fails, and the failure
reads as broken software rather than as an out-of-date sentence.

**Write documentation to be timeless.** Assume the reader is new, arrived today,
and wants to know what the software is and how to use it right now. They do not
care what changed, what it used to be called, or which version added what. So
write in the present tense about current behaviour, and leave the history out:
no changelogs, no "new in", no "recently", no "coming soon", no status or
progress sections, no roadmaps, no dated notes. Quote a version number only where
the reader cannot act without it, and prefer pointing at the file that carries it
over copying the digits. Timeless does not mean thin — what the product is, who
it is for, and how to install, configure and use it all still belong there, in
full. Documentation written this way survives a release without an edit, which is
what keeps it true; the history already has homes in the git log, the tags and
the release notes.

**Push the same day you commit.** The testnet server pulls only from GitHub, so a
branch left on one laptop is invisible to every other machine and to the box.
<!-- END SHARED AGENT CONVENTIONS -->

## This repository

- **The app runs the `arca` command-line client; it holds no wallet logic.**
  Every check, signature, fee bound and refusal is the wallet library's, in
  `ConcatenaLabs/arca`. A screen that needs something the client does not
  answer gets it added to `arca` (its command line, beside the library's
  command set `bark::arca::command`), in a pull request there, and the pin
  here moves to it. Never reimplement a wallet rule in JavaScript.
- **The pin.** `build/ARCA_COMMIT` names the arca commit the app carries;
  `build/make-arca-bundle.sh` builds `arca` from exactly that commit and
  refuses a dirty checkout. Moving the pin is a change of its own, with the
  drive run against the new client.
- **Refusals are shown in the wallet's own words.** The message of a refusal
  goes to the screen untouched; the app adds only where it came from.
- **A fee is shown before anything is signed or broadcast.** A board, a
  refresh and an exit each run the client's quote first (`board --quote`,
  `quote`, `exit --quote`), show it, and go ahead with `--shown` on exactly
  that answer; the client refuses when the fee has changed.
- **No secret on a command line.** The node's password reaches `arca create`
  in its environment and a mnemonic on its standard input
  (`--mnemonic-file -`). `src/main/commands.js` is the only way a
  window's request becomes arguments, and checks each one's form.
- **Every rail is shown.** BTC's row is first and always present, empty with
  its note while the Bitcoin side (Bark) is not carried. A new rail is an
  entry in `src/main/rails.js` and its manager, never a special case in a
  screen.
- **Bark stays upstream.** `build/BARK_COMMIT` names an upstream Bark
  release and `build/bark-testnet4.patch` is the only change on it (testnet4,
  offered upstream); the app must join any Bark ark. Nothing else of Bark is
  patched here. The Bitcoin side runs on its own queue (`main.js`), because
  Bark lets one process at a time open its wallet; every Bark run of the app
  goes through it, and `arca balance` runs with `--without-bitcoin`.
- **Tests.** `npm run lint` and `npm test` (the manager, the command
  whitelist, the scheduler, the rails and the settings, against a stand-in
  `arca`) run in CI. The drives (`test/e2e/drive.mjs`, and
  `drive-bitcoin.mjs` with a Bitcoin ark beside the operator) need running
  harnesses and are run by hand; see the README.
- **Windows.** `npm run dist:win` builds the zip on Linux once
  `build/arca-win-x64` is staged; the NSIS installer comes from the
  `windows` workflow on a Windows runner (`workflow_dispatch`). Nothing
  publishes a release automatically.

## Rules from Sequentia that bind this code

- **Bitcoin anchoring is supreme.** Finality is the node's: certified, and
  the anchor buried. The app never calls anything final that the wallet does
  not.
- **Every wallet is dual-chain.** BTC is a first-class holding on every
  screen, on its own chain.
- **No privileged asset.** No asset is a default anywhere: not in a form,
  not in a list's order, not in the headline, which is the total. The
  Sequence token (SEQ) is one asset among equals; fees default to the asset
  being moved.
- **Transparent by default.** Confidentiality is the holder's choice per
  transfer.
- **Names.** The network is Sequentia; the token is the Sequence token
  (SEQ); an exchange on it is disintermediated, never "decentralized".
- **The app stays off public web pages.** This repository and its README are
  public; no public site copy, download page included, names or links it
  until the project decides to.
