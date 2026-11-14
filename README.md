# @onecompanion/game-cli

Build, check and upload games for the [OneCompanion](https://onecompanion.net) marketplace.

You write your game in JavaScript or TypeScript against one small contract. The CLI builds it with Bun, checks it the
same way the platform will, and uploads it for review. A working example lives at
[onecompanion-net/sample-game](https://github.com/onecompanion-net/sample-game).

> This repository is generated from the OneCompanion monorepo (`packages/game-cli` and `packages/game-manifest`,
> exported by `scripts/export-game-cli.ts`). Open changes there.

## Install

Requires [Bun](https://bun.sh) 1.3 or later.

```bash
bun add -d github:onecompanion-net/game-cli
```

Add scripts to your `package.json` and run the CLI through them (`bun run validate`, `bun run publish:game`), which
use the copy in `node_modules`:

```json
"scripts": {
	"validate": "onecompanion-game validate .",
	"publish:game": "onecompanion-game publish ."
}
```

Do not use `bunx onecompanion-game`: when the package is not installed, `bunx` downloads whatever package has that
name from the public registry. The full developer guide is at `https://onecompanion.net/developers/guide`.

## Commands

| Command                                 | What it does                                                            |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `onecompanion-game validate [dir]`      | Checks `game.json`, builds the bundle into `<dir>/bundle` and checks it |
| `onecompanion-game pack [dir] --out d`  | Builds the upload bundle                                                |
| `onecompanion-game publish [dir]`       | Packs, uploads every file and submits the version for review            |
| `onecompanion-game release <versionId>` | Releases an approved version (or rolls back to an earlier one)          |
| `onecompanion-game status <versionId>`  | Shows a version's state, automatic issues and review notes              |

Uploads need a studio token (`--token` or `ONECOMPANION_TOKEN`), made on your studio page at
`https://onecompanion.net/developers`. `--api` (or `ONECOMPANION_API`) points at another environment, for example
`http://localhost:5173` on a local stack. Studios are by invitation while the marketplace is new.

## The contract

**Client** (required): an ES module exporting `mount(host, options)`, returning
`{ onMessage(bytes), pause(), resume(), dispose() }`. `options` carries `t(key, params)` for every string, `locale`,
`dir` (`ltr`/`rtl`), `online` (`{ selfId, send(bytes) }`, absent in solo), `storage` (`get`, `set`, `delete`,
`keys`: your saved data, kept by the platform, up to 10 MB) and `onEvent` (`ready`, `state`, `complete`, `fatal`).
Your game is served by OneCompanion and runs in a sandboxed frame with an anonymous origin: it has no cookies, no
browser storage of its own (use `options.storage`; a `localStorage` stand-in backed by it is provided for engines
that expect one), no network access except `online.send`, and must undo everything in `dispose()`.

**Multiplayer** (`realtime.kind` in `game.json`):

| Kind       | The room…                                                             | Ranked         |
| ---------- | --------------------------------------------------------------------- | -------------- |
| `none`     | does not exist: solo only                                             | –              |
| `relay`    | passes your bytes between players (`[0x01][to slot or 255][payload]`) | no             |
| `lockstep` | orders commands by step and keeps the log for late joiners            | no             |
| `server`   | runs your own `createGameModule()` server module (by invitation)      | staff decision |

The wire formats for `relay` and `lockstep` are documented in the platform's `packages/room-runtime/src/kinds.ts`
and summarised in the sample game's README.

## game.json

```jsonc
{
	"manifest": 1,
	"id": "your-game", // a-z, 0-9, -; 3 to 32 characters; your URL slug, never reused
	"title": "Your Game",
	"version": "1.0.0", // semver, higher than every earlier upload
	"studio": "your-studio",
	"genres": ["action"], // action | shooter | idle | rpg
	"players": { "min": 1, "max": 8 }, // max 16
	"modes": ["solo", "coop"], // solo | coop | ffa | tdm
	"entry": { "client": "./src/client.ts", "server": "./src/server.ts" },
	"realtime": { "kind": "relay", "tickRate": 0, "snapshotRate": 0, "protocol": 1 },
	"locales": ["en"], // in-game text you ship; en is required
	"messages": "./messages", // <locale>.json, flat keys, ICU plural/select allowed, no markup
	"listing": "./listing", // <locale>.json for all 12 platform locales (store text)
	"media": {
		"cover": "./art/cover.webp", // 1280×720 webp
		"stills": ["./art/a.webp", "./art/b.webp", "./art/c.webp"], // 3–8 × 1280×720, each with a -thumb.webp 320×180
		"share": "./art/share.jpg" // 1200×630 jpg
	},
	"budgets": { "clientGzipKB": 450 }, // entry + static imports, gzip
	"capabilities": {
		"pointerLock": false,
		"fullscreen": false,
		"gamepad": false,
		"audio": true,
		"network": []
	},
	"rating": { "level": "everyone", "descriptors": [] }, // everyone | teen | mature
	"rights": {
		"ownsAllContent": true,
		"thirdParty": [{ "name": "three.js", "licence": "MIT", "url": "https://…" }]
	}
}
```

The 12 platform locales are `en vi zh-hans hi es fr ar bn pt-br ru ur id`.

## What the upload contains

```
game.json  files.json  client/ (built ES modules)  server.js (one file, no imports)
messages/  listing/  media/  source/ (your source, for review only; never served)
```

The platform never unpacks archives: files are uploaded one at a time against the declared list and checked by size
and SHA-256, then validated again before review.


## License

[PolyForm Shield License 1.0.0](LICENSE.md) with the OneCompanion Games Exception (see [NOTICE.md](NOTICE.md)).
Build, test and publish games with it, and ship your games anywhere. Do not use it to build or run a competing
game platform, hosting or multiplayer service, or developer tools or AI skills for one.
