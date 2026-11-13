#!/usr/bin/env bun
/**
 * onecompanion-game: build, check and upload a game for the OneCompanion marketplace.
 *
 *   onecompanion-game validate [dir]            check game.json, then build and check the bundle
 *   onecompanion-game pack [dir] [--out dir]    build the upload bundle (default <dir>/bundle)
 *   onecompanion-game publish [dir]             pack, upload and submit for review
 *   onecompanion-game release <versionId>       release an approved version
 *   onecompanion-game status <versionId>        a version's state and review notes
 *
 * Upload options: --api <url> (or ONECOMPANION_API, default https://onecompanion.net) and --token <studio token>
 * (or ONECOMPANION_TOKEN). Tokens are made on /developers/studio.
 */
import { parseArgs } from 'node:util';
import {
	CliError,
	pack,
	readSourceManifest,
	release,
	upload,
	versionStatus,
	type Api
} from './index.ts';
import type { Issue } from './manifest/index.ts';

const { values: o, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: 'string' },
		api: { type: 'string' },
		token: { type: 'string' },
		help: { type: 'boolean', short: 'h' }
	}
});
const [command, arg] = positionals;

const printIssues = (issues: Issue[]) => {
	for (const i of issues) console.error(`  ✗ ${i.path}: ${i.message}`);
};

function api(): Api {
	const token = o.token ?? process.env.ONECOMPANION_TOKEN;
	if (!token) throw new CliError('a studio token is required: --token or ONECOMPANION_TOKEN');
	return { url: o.api ?? process.env.ONECOMPANION_API ?? 'https://onecompanion.net', token };
}

async function main(): Promise<number> {
	const dir = arg ?? '.';
	switch (command) {
		case 'validate': {
			const { manifest } = await readSourceManifest(dir);
			console.log(`${manifest.title} ${manifest.version}: game.json ok`);
			const r = await pack(dir, o.out);
			if (!r.report.ok) {
				console.error(`bundle has ${r.report.issues.length} problem(s):`);
				printIssues(r.report.issues);
				return 1;
			}
			console.log(
				`bundle ok: client entry ${(r.report.clientGzipBytes / 1024).toFixed(1)} KB gzip, ${r.files.length} files`
			);
			return 0;
		}
		case 'pack': {
			const r = await pack(dir, o.out);
			console.log(`packed ${r.files.length} files into ${r.out}`);
			if (!r.report.ok) {
				printIssues(r.report.issues);
				return 1;
			}
			return 0;
		}
		case 'publish': {
			const r = await pack(dir, o.out);
			if (!r.report.ok) {
				console.error('not uploading: the bundle has problems');
				printIssues(r.report.issues);
				return 1;
			}
			const p = await upload(api(), r.out, (s) => console.log(s));
			console.log(`state: ${p.state}`);
			if (p.issues.length) printIssues(p.issues);
			return p.state === 'in_review' ? 0 : 1;
		}
		case 'release': {
			if (!arg) throw new CliError('usage: release <versionId>');
			console.log(`state: ${(await release(api(), arg)).state}`);
			return 0;
		}
		case 'status': {
			if (!arg) throw new CliError('usage: status <versionId>');
			console.log(JSON.stringify(await versionStatus(api(), arg), null, 2));
			return 0;
		}
		default:
			console.log(
				'usage: onecompanion-game <validate|pack|publish|release|status> [dir|versionId] [--out dir] [--api url] [--token t]'
			);
			return o.help ? 0 : 2;
	}
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		if (err instanceof CliError) {
			console.error(`error: ${err.message}`);
			printIssues(err.issues);
		} else console.error(err);
		process.exit(1);
	}
);
