/*
 * Turns the fixture in `releases.js` into something a BitTorrent client can actually
 * download: a tree of content named the way the releases are named, one `.torrent` per
 * release, and a manifest the indexer reads to answer searches.
 *
 *     node make-torrents.js <media-root> <content-root> <torrent-root>
 *
 * The bencoding is in `bencode.js`, shared with the tracker. It is written by hand,
 * with no dependency, for one reason worth stating: the lab already mounts whatever
 * `node_modules` the repository happens to hold, and adding a torrent library to the
 * workspace's dependencies would put a package in the product's tree that only the lab
 * ever loads. Bencode is four rules and a SHA-1 loop; a dependency is a version to
 * keep, an audit entry and an install that has to succeed offline.
 *
 * Nothing here carries a creation date, and that is deliberate rather than lazy. The
 * info hash is the SHA-1 of the info dictionary, so a timestamp inside it would give
 * every run a new hash — the seeding client would hold torrents nobody asks for, the
 * magnets printed by the last run would resolve to nothing, and a fixture whose
 * identity changes every time it is rebuilt cannot be referenced from a test. As it is,
 * the same media and the same fixture always produce the same info hash.
 *
 * None of these torrents is marked private, and that is a decision rather than an
 * omission — the obvious one, and it was tried first. `private: 1` tells every client to
 * use the tracker and nothing else, which is exactly what a lab wants; it also breaks
 * every magnet in the lab, silently and permanently. libtorrent does not attach its
 * `ut_metadata` plugin to a torrent it already has metadata for when that torrent is
 * private, so the seeding client never offers the metadata over the wire, and a client
 * given a magnet sits in `metaDL` at 0 % for ever with a connected peer, no error on
 * either side and nothing in any log. Measured in this lab: the same content as two
 * torrents differing only in that flag, added to the seeder, then magnet-added to the
 * downloader — the public one completed in under three seconds, the private one was
 * still at `metaDL` half an hour later.
 *
 * What keeps the lab offline instead is the clients' own configuration: DHT, peer
 * exchange and local discovery are turned off in both of them by
 * `setup-qbittorrent.sh`, and the only tracker any of these torrents names is the lab's
 * own. If you put the private flag back, magnets stop working and `.torrent` grabs keep
 * working, which is about as misleading as a lab can be.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { encode: bencode } = require('./bencode.js');
const releases = require('./releases.js');

const [mediaRoot, contentRoot, torrentRoot] = process.argv.slice(2);

if (!mediaRoot || !contentRoot || !torrentRoot) {
	console.error('usage: make-torrents.js <media-root> <content-root> <torrent-root>');
	process.exit(1);
}

// The URL written into every torrent, and therefore the only address the clients will
// ever announce to. A container name rather than `localhost`, because the clients are
// containers: a magnet that says `localhost` sends qBittorrent to its own loopback,
// where it finds no tracker and waits for a tracker that will never answer.
const announce = process.env.LAB_TRACKER_ANNOUNCE || 'http://fake-indexer:9117/announce';

// Small, because the files are small: a 100 KB file under the usual 256 KB piece is one
// piece, and a one-piece torrent can never show a partial download. Four pieces can.
const PIECE_LENGTH = 32768;

function placeContent(release) {
	const single = release.files.length === 1;
	// A single-file torrent's name *is* its file name, and a multi-file torrent's name is
	// the directory the files land in. Getting this wrong makes a grab save one file
	// named after a folder, or a folder named after an episode.
	const base = single ? contentRoot : path.join(contentRoot, release.title);
	const placed = [];

	for (const file of release.files) {
		const target = single ? path.join(contentRoot, file.as) : path.join(base, file.as);
		const source = path.join(mediaRoot, file.from);

		if (!fs.existsSync(source)) {
			throw new Error(`${release.key}: ${file.from} is not in the lab media; run seed-media.sh first`);
		}

		fs.mkdirSync(path.dirname(target), { recursive: true });

		// Copied only when it is not already there, like `seed-media.sh`: this runs again
		// on every `lab/seed-torrents`, over a tree a seeding client is reading from, and
		// rewriting a file under a running seeder is how a torrent goes from complete to
		// "missing files" for no reason anybody can see.
		if (!fs.existsSync(target)) {
			fs.copyFileSync(source, target);
		}

		placed.push({ path: target, length: fs.statSync(target).size, name: file.as });
	}

	return { name: single ? release.files[0].as : release.title, single, placed };
}

function hashPieces(files) {
	const hashes = [];
	let piece = Buffer.alloc(0);

	// The pieces run over the concatenation of every file in order, not over each file
	// separately: a piece straddles a file boundary, and a torrent hashed per file is
	// rejected by every client with a hash mismatch on the first shared piece.
	for (const file of files) {
		let rest = fs.readFileSync(file.path);

		while (piece.length + rest.length >= PIECE_LENGTH) {
			const take = PIECE_LENGTH - piece.length;

			hashes.push(crypto.createHash('sha1').update(Buffer.concat([piece, rest.subarray(0, take)])).digest());
			piece = Buffer.alloc(0);
			rest = rest.subarray(take);
		}

		piece = Buffer.concat([piece, rest]);
	}

	if (piece.length > 0) {
		hashes.push(crypto.createHash('sha1').update(piece).digest());
	}

	return Buffer.concat(hashes);
}

fs.mkdirSync(contentRoot, { recursive: true });
fs.mkdirSync(torrentRoot, { recursive: true });

const manifest = { announce, torrents: {} };

for (const release of releases) {
	const { name, single, placed } = placeContent(release);
	const length = placed.reduce((total, file) => total + file.length, 0);

	const info = {
		name,
		'piece length': PIECE_LENGTH,
		pieces: hashPieces(placed),
		...(single
			? { length }
			: { files: placed.map((file) => ({ length: file.length, path: file.name.split('/') })) }),
	};

	const infoHash = crypto.createHash('sha1').update(bencode(info)).digest('hex');
	const file = path.join(torrentRoot, `${release.key}.torrent`);

	fs.writeFileSync(file, bencode({ announce, 'created by': 'media-center-sync lab', info }));

	manifest.torrents[release.key] = {
		name,
		infoHash,
		length,
		files: placed.map((placedFile) => ({ name: placedFile.name, length: placedFile.length })),
		torrent: path.basename(file),
	};

	console.log(`  ${release.key}  ${infoHash}  ${length} bytes, ${placed.length} file(s)`);
}

// The manifest, and not a second copy of the fixture: the indexer needs the info hash
// and the byte count of each torrent to answer a search, and both are results of the
// hashing above. Recomputing them in the indexer would mean two implementations of
// bencode in one lab, free to disagree.
fs.writeFileSync(path.join(torrentRoot, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
