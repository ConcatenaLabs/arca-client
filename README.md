# Arca client

A desktop app for Linux and Windows. You join an Arca operator with it and use
the operator as a wallet. The wallet is dual-chain:

- every Sequentia asset, held as Arca coins (leaves of the operator's covenant
  trees) and as on-chain coins;
- BTC, held on Bitcoin itself in a Bitcoin ark.

Sequentia is a Bitcoin sidechain for asset tokenization and disintermediated
exchanges. On it, the Arca protocol lets an operator batch many people's coins
into one on-chain output. Each holder keeps a coin they can take to the chain
on their own, without the operator.

The app carries the Arca command-line client, `arca`, built from
[ConcatenaLabs/arca](https://github.com/ConcatenaLabs/arca) at the commit
pinned in [`build/ARCA_COMMIT`](build/ARCA_COMMIT). Everything the wallet
does is done by that client: every check, signature, fee bound and refusal.
The app runs it and shows what it says.

> **Testnet software.** Do not use it with anything of value.

## What you need

- **A Sequentia Core node** (`sequentiad`) that you run or trust, reachable
  over JSON-RPC, started with `-txindex` and `-validateanchor`. The wallet
  reads the chain only from this node. A node that does not validate its
  Bitcoin anchors has no notion of finality, and the wallet refuses it.
- **An operator's address**: the base URL of its Arca server. Plain `http://`
  is refused except to this machine.

## Using it

The left rail holds the screens. BTC's row is always first in the wallet,
because BTC is a holding on its own chain. The headline is the total of every
Sequentia asset, valued at your own node's rates. No asset comes first or is
a default.

| Screen | What it does |
| --- | --- |
| Join | Tests the node, takes the operator's address, and creates a wallet or restores one from its mnemonic. It shows the operator key the wallet pins. Compare that key with the one the operator publishes through a channel you trust. A new wallet's mnemonic is shown once, to write down |
| Wallet | The total, then one row per holding: BTC, then each Sequentia asset, split into on-chain and Arca coins by state |
| Board | A new on-chain address to pay, and boarding: on-chain coins brought into Arca. The board's fee, size and the coins it spends are shown before anything is signed. A board is spendable once its transaction is final |
| Send | Pays a receive request out of round. The asset is the one the request names, or the one you name. There is no default asset |
| Receive | Makes a request for one payment, shown and copied. It lapses 27 days after it is made. The screen also lists the requests still waiting for a payment |
| Coins | Every coin with its state and dates. A coin received out of round is *operator-confirmed*. **Settle now** shows each coin's refresh fee before anything is signed, then signs for exactly those fees and hands the coin to the operator's next round |
| Schedule | When the wallet must next sync (`next_sync_at`, the chain's median time) and why, each coin's dates, and the syncs this run of the app made |
| Exit drill | Takes a coin to the chain from its record alone, without the operator. Each run shows what it would broadcast and at what fee, then goes as far as the chain allows: the unroll, then the claim once the exit delay has run |
| Refusals | Every refusal, in the wallet's own words: those of this session, and the wallet's own record |
| Settings | The node and operator the wallet pinned, the client in use, and the log of every run of `arca` |

While the app runs, it keeps the wallet synced on the wallet library's own
schedule. It reads `arca schedule` every two minutes and runs `arca sync`
when the wallet says a sync is due, or when the chain's median time reaches
the earliest `next_sync_at` the wallet has named since the last sync. It also
syncs when it starts, and at least once a day. A coin's refresh in its free window, and taking a coin home
before its exit date, both happen through these syncs. **Keep the app
running, or run `arca sync` yourself, at least once a day** while the wallet
holds coins off the chain or waits for a payment.

The Bitcoin side runs through Bark, which the `arca` client drives when Bark
sits beside it. A build that does not carry Bark shows BTC's row, empty,
saying so.

## Where your data lives

| What | Where |
| --- | --- |
| The wallet: `mnemonic`, `arca.sqlite`, the node's password (`node_password`) | `~/.arca-client/sequentia/` (each file readable by its owner alone) |
| The app's settings (`config.json`) | Linux `~/.config/Arca/`, Windows `%APPDATA%\Arca\` |

Back up the mnemonic. It restores the wallet on another machine: every coin
the operator serves to its mailbox key, each checked against the chain, and
every on-chain coin.

`ARCA_CLIENT_HOME` moves both under one directory, for a second profile.

### Attaching to a wallet you already run

Under Settings, "Attach" points the app at an `arca` binary and a wallet
directory that you already use from the command line, such as `~/.arca`.
The app then drives that wallet in place of its own. Only one program should
drive a wallet directory at a time.

## How the app runs the wallet

The Electron main process owns the wallet. The window is sandboxed (context
isolation, no Node integration, a `default-src 'self'` content security
policy) and sees only the `window.arca` API in
[`src/main/preload.js`](src/main/preload.js).

[`src/main/arca.js`](src/main/arca.js) is the manager. It runs `arca`
once per command with the wallet's `--datadir`:

- **One run at a time.** Commands queue, so two runs never meet in one store.
- **A deadline for every run.** A run past its deadline is asked to stop,
  then killed.
- **A clean quit.** Quitting waits for the run in flight and starts no other.
- **Answers and refusals untouched.** `arca` prints JSON. A refusal is
  `{"error": {"kind", "message"}}`, with the server's `code` and `status`
  when the server refused, and its message reaches the screen as written.
- **No secret on a command line.** The node's password goes to
  `arca create` in its environment, and a mnemonic to restore goes on its
  standard input (`--mnemonic-file -`).
- **The fee shown before anything is signed or broadcast.** A board, a
  refresh and an exit run the client's quote first (`board --quote`,
  `quote`, `exit --quote`), and go ahead with `--shown` on exactly what was
  shown; the client refuses when the fee has changed since.
- **Every argument checked.** [`src/main/commands.js`](src/main/commands.js)
  is the only path from a window's request to the command line, and it
  checks the form of each argument.

[`src/main/scheduler.js`](src/main/scheduler.js) keeps the schedule.
[`src/main/rails.js`](src/main/rails.js) lists the chains the wallet holds
coins on, BTC's first.

## Building

Requires Node.js 22 and, for the client, a Rust toolchain and `protoc`
(`apt install protobuf-compiler`). Bark's crates need it.

```
npm install
npm run bundle:arca     # builds arca at build/ARCA_COMMIT into build/arca-linux-x64
npm start               # the app from this checkout, with that client
```

`build/make-arca-bundle.sh` clones arca into `build/cache/arca` unless
`ARCA_SRC` names a clean clone. It checks out the pinned commit and builds
`arca` in release mode, with every build path mapped away. It then checks
that the binary names no directory of the machine that built it.
`TARGET=x86_64-pc-windows-gnu` builds the Windows client into
`build/arca-win-x64`.

```
npm run dist:linux      # dist/Arca-<version>-linux-x86_64.AppImage
npm run dist:win        # dist/Arca-<version>-win64.zip (with build/arca-win-x64 staged)
```

Both are built by the `ci` workflow: the AppImage on every change, and the
Windows zip and one-file installer on demand (`workflow_dispatch`). The
artifacts are unsigned.

## Testing

```
npm run lint
npm test
```

`npm test` runs the manager, the command whitelist, the scheduler, the rails
and the settings against a stand-in `arca`
([`test/fixtures/fake-arca.js`](test/fixtures/fake-arca.js)).

[`test/e2e/drive.mjs`](test/e2e/drive.mjs) drives the app end to end, with
Playwright for Electron, against a whole Arca operator on an anchored
regtest chain. That operator is arca's test harness,
`bark-cli/tests/arca_operator_for_browsers.rs`, kept running with a control
address. The drive takes the steps below, photographs each one, and checks
its effect on the chain at the node:

1. A fresh install joins and boards.
2. It receives from a wallet run on the command line, and sends to it.
3. It settles a received coin into a round.
4. It runs the exit drill to a final claim.
5. It syncs by itself when the schedule says so.
6. It shows each refusal in the wallet's words.
7. A second fresh install restores the wallet from its mnemonic and holds the
   same coins.

```
# in an arca checkout, with SEQUENTIAD_EXEC, ARCA_TEST_POSTGRES and the signer as arca's tests need
ARCA_OPERATOR_CONTROL=127.0.0.1:18640 cargo test -p arca-cli --test arca_operator_for_browsers -- --ignored --nocapture
# here
ARCA_OPERATOR_CONTROL=127.0.0.1:18640 npm run drive -- test-results/drive
```

The drive renders the window offscreen (`ARCA_CLIENT_OFFSCREEN=1`), so it
shows nothing on the screen of the machine it runs on. `ARCA_CLIENT_APP`
points it at a packaged app's executable instead of this checkout.

## Layout

```
src/main/main.js        Electron main: settings, the window, IPC
src/main/arca.js        the manager: runs arca once per command
src/main/commands.js    the wallet commands a window may ask for, as arguments
src/main/scheduler.js   syncs on the wallet's schedule while the app runs
src/main/rails.js       the chains the wallet holds coins on
src/main/node-rpc.js    JSON-RPC to Sequentia Core, for the node test
src/main/config.js      the app's settings
src/main/preload.js     the only API the window sees (window.arca)
src/renderer/           the screens
build/ARCA_COMMIT       the arca commit the app carries
build/make-arca-bundle.sh   builds and stages arca from that commit
build/make-icon.js      draws build/icon.png
test/                   unit tests, the stand-in arca, and the drive
```

## License

MIT. Built by Concatena Labs.
