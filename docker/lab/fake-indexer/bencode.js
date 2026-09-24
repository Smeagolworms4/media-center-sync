/*
 * Bencode, the encoding half only, shared by the two halves of the lab indexer: the
 * builder writes `.torrent` files with it and the tracker answers announces with it.
 *
 * It lives in its own file because the alternative was two encoders in one lab, and a
 * tracker whose dictionaries disagree with the builder's about key order answers
 * something every client parses as garbage — with no error naming either side.
 *
 * Buffers encode as byte strings, which is the only reason this works at all: the
 * `pieces` field and a compact peer list are binary, and a Buffer put through a
 * string-only encoder comes out as UTF-8 and is silently the wrong length.
 */
function encode(value) {
	if (Buffer.isBuffer(value)) {
		return Buffer.concat([Buffer.from(`${value.length}:`), value]);
	}

	if (typeof value === 'string') {
		return encode(Buffer.from(value, 'utf8'));
	}

	if (typeof value === 'number') {
		return Buffer.from(`i${Math.trunc(value)}e`);
	}

	if (Array.isArray(value)) {
		return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
	}

	// Sorted keys, and not for tidiness: two encoders that disagree on the order of the
	// info dictionary produce two different info hashes for one torrent, and the
	// mismatch only ever surfaces as a client that refuses a file it holds in full.
	const keys = Object.keys(value).sort();

	return Buffer.concat([
		Buffer.from('d'),
		...keys.map((key) => Buffer.concat([encode(key), encode(value[key])])),
		Buffer.from('e'),
	]);
}

module.exports = { encode };
