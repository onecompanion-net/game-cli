import { describe, expect, it } from 'bun:test';
import { newVersionId, signPreview, verifyPreview, VERSION_ID } from './preview.ts';

describe('preview tokens', () => {
	const now = Date.parse('2026-11-14T00:00:00Z');
	it('verifies only for the same game, version and secret, before expiry', async () => {
		const t = await signPreview('s3cret', 'acme-game', 'v1', now, 60);
		expect(await verifyPreview('s3cret', t, 'acme-game', 'v1', now)).toBe(true);
		expect(await verifyPreview('s3cret', t, 'acme-game', 'v2', now)).toBe(false);
		expect(await verifyPreview('s3cret', t, 'other-game', 'v1', now)).toBe(false);
		expect(await verifyPreview('wrong', t, 'acme-game', 'v1', now)).toBe(false);
		expect(await verifyPreview('s3cret', t, 'acme-game', 'v1', now + 61_000)).toBe(false);
		expect(await verifyPreview('', t, 'acme-game', 'v1', now)).toBe(false);
		expect(await verifyPreview('s3cret', `${t}x`, 'acme-game', 'v1', now)).toBe(false);
	});

	it('makes sortable version ids', () => {
		const a = newVersionId(now);
		const b = newVersionId(now + 1);
		expect(a).toMatch(VERSION_ID);
		expect(a < b).toBe(true);
	});
});
