import { describe, expect, it } from 'bun:test';
import { fakeGlb, manifest } from './fixtures.ts';
import { CONTENT_TYPES, glbProblems, magicMatches } from './files.ts';
import { parseManifest } from './schema.ts';

describe('asset file types', () => {
	it('recognises GLB, KTX2 and AVIF by their first bytes', () => {
		expect(CONTENT_TYPES.glb).toBe('model/gltf-binary');
		expect(magicMatches('glb', fakeGlb({ asset: { version: '2.0' } }))).toBe(true);
		const ktx = new Uint8Array([
			0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, 0
		]);
		expect(magicMatches('ktx2', ktx)).toBe(true);
		const avif = new Uint8Array(
			[0, 0, 0, 0x1c, ...'ftypavif'].map((c) => (typeof c === 'string' ? c.charCodeAt(0) : c))
		);
		expect(magicMatches('avif', avif)).toBe(true);
		expect(magicMatches('glb', avif)).toBe(false);
	});

	it('a GLB must embed its buffers and images', () => {
		expect(
			glbProblems(fakeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }))
		).toEqual([]);
		expect(
			glbProblems(
				fakeGlb({
					asset: { version: '2.0' },
					buffers: [{ uri: 'mesh.bin', byteLength: 4 }],
					images: [{ uri: 'data:image/png;base64,AAAA' }]
				})
			)
		).toEqual([
			'buffers[0] points at a file or data URI: embed it',
			'images[0] points at a file or data URI: embed it'
		]);
		const short = fakeGlb({ asset: { version: '2.0' } }).subarray(0, 30);
		expect(glbProblems(short)).toEqual(['the header length does not match the file']);
	});

	it('a manifest may list the asset paths its code needs', () => {
		expect(parseManifest(manifest({ assets: { required: ['ui/ember.webp'] } }), 'bundle').ok).toBe(
			true
		);
		const bad = parseManifest(manifest({ assets: { required: ['../x.png'] } }), 'bundle');
		expect(bad.ok).toBe(false);
	});
});
