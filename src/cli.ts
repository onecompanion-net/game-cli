#!/usr/bin/env bun
/**
 * onecompanion-game: build, check and upload a game for the OneCompanion marketplace.
 *
 *   onecompanion-game init [dir] --template solo|relay|lockstep [--id x] [--studio x] [--title x]
 *                                               start a new game that passes validate as generated
 *   onecompanion-game i18n [dir] [--locales all|vi,ja]
 *                                               add missing languages as marked copies of English and print a
 *                                               prompt for your AI tool to translate them
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
import { i18n, init, TEMPLATES, type I18nResult, type Template } from './scaffold.ts';

const { values: o, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: 'string' },
		api: { type: 'string' },
		token: { type: 'string' },
		template: { type: 'string', short: 't' },
		id: { type: 'string' },
		studio: { type: 'string' },
		title: { type: 'string' },
		locales: { type: 'string' },
		help: { type: 'boolean', short: 'h' }
	}
});
const [command, arg] = positionals;

const printIssues = (issues: Issue[]) => {
	for (const i of issues) console.error(`  ✗ ${i.path}: ${i.message}`);
};

function printI18n(r: I18nResult) {
	for (const f of r.created) console.log(`  + ${f}`);
	if (!r.prompt) {
		console.log('every text file is translated');
		return;
	}
	console.log(
		`\n${r.untranslated.length} file(s) still need translating. Paste this into your AI coding tool:\n`
	);
	console.log(r.prompt);
}

function api(): Api {
	const token = o.token ?? process.env.ONECOMPANION_TOKEN;
	if (!token) throw new CliError('a studio token is required: --token or ONECOMPANION_TOKEN');
	return { url: o.api ?? process.env.ONECOMPANION_API ?? 'https://onecompanion.net', token };
}

async function main(): Promise<number> {
	const dir = arg ?? '.';
	switch (command) {
		case 'init': {
			const template = (o.template ?? 'solo') as Template;
			if (!TEMPLATES.includes(template))
				throw new CliError(`--template must be one of ${TEMPLATES.join(', ')}`);
			const r = await init(dir, {
				template,
				...(o.id ? { id: o.id } : {}),
				...(o.studio ? { studio: o.studio } : {}),
				...(o.title ? { title: o.title } : {})
			});
			console.log(`created a ${template} game in ${r.dir} (${r.files.length} files)`);
			console.log(`next: cd ${arg ?? '.'} && bun install && bun run dev`);
			console.log(
				'then: set the id and studio in game.json, replace the art, and run bun run i18n to translate the listing'
			);
			return 0;
		}
		case 'i18n': {
			const locales =
				o.locales === 'all'
					? ('all' as const)
					: o.locales
						? o.locales
								.split(',')
								.map((l) => l.trim())
								.filter(Boolean)
						: undefined;
			printI18n(await i18n(dir, locales ? { locales } : {}));
			return 0;
		}
		case 'validate': {
			const { manifest } = await readSourceManifest(dir);
			console.log(`${manifest.title} ${manifest.version}: game.json ok`);
			const r = await pack(dir, o.out, { allowUntranslated: true });
			if (!r.report.ok) {
				console.error(`bundle has ${r.report.issues.length} problem(s):`);
				printIssues(r.report.issues);
				return 1;
			}
			console.log(
				`bundle ok: client entry ${(r.report.clientGzipBytes / 1024).toFixed(1)} KB gzip, ${r.files.length} files`
			);
			if (r.report.untranslated.length)
				console.warn(
					`note: ${r.report.untranslated.length} text file(s) are still untranslated copies of English. Uploads refuse them: run "onecompanion-game i18n" for a prompt to translate them.`
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
				'usage: onecompanion-game <init|i18n|validate|pack|publish|release|status> [dir|versionId] [--template solo|relay|lockstep] [--locales all|vi,ja] [--out dir] [--api url] [--token t]'
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
