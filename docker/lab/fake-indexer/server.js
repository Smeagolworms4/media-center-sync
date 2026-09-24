/*
 * The lab's indexer and the lab's tracker, in one process: a Torznab API Prowlarr
 * accepts as a Generic Torznab indexer, the `.torrent` files it points at, and the
 * HTTP tracker those torrents announce to.
 *
 * Why an indexer at all, when Prowlarr can talk to a real one: a search result is the
 * one input the release feature has that nobody can fix. A public tracker answers
 * whatever it happens to be seeding today, so the parser cases that matter — a run of
 * episodes under one info hash, a season pack with no episode number, the show whose
 * article moved to the back — appear on some days and not others, and a test written
 * against them fails for reasons that have nothing to do with this repository. Here the
 * answer is a file, it is the same every time, and every release in it exists because
 * it pins something (see `releases.js`).
 *
 * Why the tracker is in the same process: the alternative was a second container for
 * sixty lines of announce handling. The two are one fixture — a release the indexer
 * offers is a torrent this tracker knows peers for — and splitting them would only buy
 * a second thing to start and a second place for the announce URL to be wrong.
 *
 * Nothing here is authenticated and nothing needs to be. Prowlarr insists on an API key
 * field for a Torznab indexer, it is sent on every call, and this ignores it: a lab that
 * refused the wrong key would spend its first afternoon proving it can refuse the wrong
 * key.
 *
 * It has no dependency and is run by `node:24` over a mounted directory, so there is
 * nothing to build and nothing to install. `docker compose restart fake-indexer` is the
 * whole edit-and-see loop.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const { encode: bencode } = require('./bencode.js');
const releases = require('./releases.js');

const PORT = Number(process.env.PORT || 9117);
const TORRENT_DIR = process.env.TORRENT_DIR || '/torrents';
const TITLE = 'Lab Fake Indexer';

// Half a minute, because the lab is watched by a human waiting for a download to start.
// A real tracker says 1800 and a client that missed its first announce then sits idle
// for half an hour, which reads exactly like a tracker that is not answering.
const ANNOUNCE_INTERVAL = 30;

// Four missed announces. A seeder that is restarted keeps its slot long enough for the
// downloader's next announce to still find it.
const PEER_TIMEOUT = 4 * ANNOUNCE_INTERVAL * 1000;

/*
 * Read on every search rather than at startup, and that is the whole reason this is a
 * function. `seed-torrents.sh` runs after the container is up — it has to, it uses the
 * tracker — so a manifest cached at startup is the empty one, and every search answers
 * nothing until somebody thinks to restart a container nobody told them about.
 */
function manifest() {
	try {
		return JSON.parse(fs.readFileSync(path.join(TORRENT_DIR, 'manifest.json'), 'utf8'));
	} catch {
		return { announce: '', torrents: {} };
	}
}

function escapeXml(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/*
 * The query string is parsed by hand because one parameter is not text: `info_hash` is
 * twenty raw bytes percent-encoded, and every high-level URL parser in Node hands it
 * back as a UTF-8 string — where any byte over 0x7F has already been replaced by the
 * replacement character. The hash is then wrong for about nine torrents in ten, which
 * shows up as a tracker that knows no peers for anything.
 */
function rawQuery(url) {
	const start = url.indexOf('?');
	const out = new Map();

	if (start < 0) {
		return out;
	}

	for (const pair of url.slice(start + 1).split('&')) {
		if (pair === '') {
			continue;
		}

		const split = pair.indexOf('=');
		const key = split < 0 ? pair : pair.slice(0, split);

		out.set(decodeURIComponent(key), split < 0 ? '' : pair.slice(split + 1));
	}

	return out;
}

function decodeText(value) {
	return decodeURIComponent((value ?? '').replace(/\+/g, ' '));
}

function decodeBytes(value) {
	const bytes = [];

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];

		if (character === '%') {
			bytes.push(parseInt(value.slice(index + 1, index + 3), 16));
			index += 2;
		} else if (character === '+') {
			bytes.push(0x20);
		} else {
			bytes.push(value.charCodeAt(index) & 0xff);
		}
	}

	return Buffer.from(bytes);
}

function normalise(text) {
	return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function matches(release, query) {
	const requested = query.get('q') ? decodeText(query.get('q')) : '';
	const title = normalise(release.title);

	// Every word of the query has to appear somewhere in the title, and a partial word
	// counts: Prowlarr sends the show title it holds, which is spelled with spaces and
	// apostrophes where the release has dots, so anything stricter than this answers
	// nothing for searches a real indexer answers.
	for (const word of normalise(requested).trim().split(' ')) {
		if (word !== '' && !title.includes(word)) {
			return false;
		}
	}

	const categories = decodeText(query.get('cat') || '')
		.split(',')
		.map((value) => Number(value))
		.filter((value) => value > 0);

	// A request for `5000` means the whole tree: Prowlarr maps its own categories onto
	// whatever caps advertised, and an indexer that answered only exact matches would
	// hand back nothing for every search made from a category rather than a query.
	if (categories.length > 0) {
		const parent = release.category - (release.category % 1000);

		if (!categories.includes(release.category) && !categories.includes(parent)) {
			return false;
		}
	}

	const season = Number(decodeText(query.get('season') || '')) || 0;

	if (season > 0 && !release.seasons.includes(season)) {
		return false;
	}

	const episode = Number(decodeText(query.get('ep') || '')) || 0;

	// A pack has no episode list and answers every episode search for its season, which
	// is not a shortcut: it is what the packs are in the fixture for. Whatever decides
	// between "the episode" and "the pack that contains it" has to see both offered.
	if (episode > 0 && release.episodes.length > 0 && !release.episodes.includes(episode)) {
		return false;
	}

	return true;
}

function caps() {
	return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
	<server title="${escapeXml(TITLE)}" version="1.0"/>
	<limits max="100" default="100"/>
	<retention days="9999"/>
	<registration available="no" open="no"/>
	<searching>
		<search available="yes" supportedParams="q"/>
		<tv-search available="yes" supportedParams="q,season,ep"/>
		<movie-search available="yes" supportedParams="q"/>
		<music-search available="no" supportedParams="q"/>
		<audio-search available="no" supportedParams="q"/>
		<book-search available="no" supportedParams="q"/>
	</searching>
	<categories>
		<category id="2000" name="Movies">
			<subcat id="2040" name="Movies/HD"/>
			<subcat id="2045" name="Movies/UHD"/>
		</category>
		<category id="5000" name="TV">
			<subcat id="5040" name="TV/HD"/>
			<subcat id="5045" name="TV/UHD"/>
		</category>
	</categories>
</caps>
`;
}

function item(release, torrent, announce, base) {
	const download = `${base}/download/${release.key}.torrent`;
	const magnet = `magnet:?xt=urn:btih:${torrent.infoHash}`
		+ `&dn=${encodeURIComponent(torrent.name)}`
		+ (announce ? `&tr=${encodeURIComponent(announce)}` : '');
	const parent = release.category - (release.category % 1000);

	// `seeders` and `peers`, with peers counting the seeders: Prowlarr reads the leecher
	// count as `peers - seeders`, so a feed that put the leechers in `peers` reports
	// negative leechers and an indexer that looks permanently dead.
	return `		<item>
			<title>${escapeXml(release.title)}</title>
			<guid>${escapeXml(download)}</guid>
			<link>${escapeXml(download)}</link>
			<comments>${escapeXml(`${base}/#${release.key}`)}</comments>
			<pubDate>${new Date(release.published).toUTCString()}</pubDate>
			<size>${torrent.length}</size>
			<category>${release.category}</category>
			<description>${escapeXml(release.title)}</description>
			<enclosure url="${escapeXml(download)}" length="${torrent.length}" type="application/x-bittorrent"/>
			<torznab:attr name="category" value="${parent}"/>
			<torznab:attr name="category" value="${release.category}"/>
			<torznab:attr name="seeders" value="${release.seeders}"/>
			<torznab:attr name="peers" value="${release.seeders + release.leechers}"/>
			<torznab:attr name="infohash" value="${torrent.infoHash}"/>
			<torznab:attr name="magneturl" value="${escapeXml(magnet)}"/>
			<torznab:attr name="downloadvolumefactor" value="1"/>
			<torznab:attr name="uploadvolumefactor" value="1"/>
		</item>
`;
}

function feed(query, base, only) {
	const { announce, torrents } = manifest();
	const offset = Number(decodeText(query.get('offset') || '')) || 0;
	const limit = Number(decodeText(query.get('limit') || '')) || 100;

	/*
	 * Only what the tracker actually has. A release whose torrent has not been built is
	 * left out on purpose: offering it would produce a grab that Prowlarr accepts,
	 * qBittorrent adds, and that then sits at 0 % forever with nothing anywhere saying
	 * the file was never seeded.
	 */
	const found = releases.filter((release) => torrents[release.key]
		&& only(release)
		&& matches(release, query));

	const items = found
		.slice(offset, offset + limit)
		.map((release) => item(release, torrents[release.key], announce, base))
		.join('');

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
	<channel>
		<atom:link href="${escapeXml(`${base}/api`)}" rel="self" type="application/rss+xml"/>
		<title>${escapeXml(TITLE)}</title>
		<description>A fixed fixture of releases, seeded locally by the lab</description>
		<link>${escapeXml(base)}</link>
		<language>en-GB</language>
		<category>search</category>
		<torznab:response offset="${offset}" total="${found.length}"/>
${items}	</channel>
</rss>
`;
}

function torznabError(code, description) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<error code="${code}" description="${escapeXml(description)}"/>
`;
}

const peers = new Map();

function peersFor(hash) {
	if (!peers.has(hash)) {
		peers.set(hash, new Map());
	}

	const swarm = peers.get(hash);
	const deadline = Date.now() - PEER_TIMEOUT;

	for (const [key, peer] of swarm) {
		if (peer.seen < deadline) {
			swarm.delete(key);
		}
	}

	return swarm;
}

function announceReply(query, address) {
	const hash = decodeBytes(query.get('info_hash') || '');

	if (hash.length !== 20) {
		return bencode({ 'failure reason': 'info_hash must be twenty bytes' });
	}

	const port = Number(decodeText(query.get('port') || '')) || 0;

	if (port <= 0 || port > 65535) {
		return bencode({ 'failure reason': 'port is missing or out of range' });
	}

	// The address the connection came from, never the one the client claims. A client
	// behind a container bridge reports its own idea of its address, and a tracker that
	// believed it hands every other peer a route to nowhere.
	const ip = address.replace(/^::ffff:/, '');
	const swarm = peersFor(hash.toString('hex'));
	const key = `${ip}:${port}`;
	const event = decodeText(query.get('event') || '');

	if (event === 'stopped') {
		swarm.delete(key);
	} else {
		swarm.set(key, { ip, port, left: Number(decodeText(query.get('left') || '')) || 0, seen: Date.now() });
	}

	const others = [...swarm.values()].filter((peer) => `${peer.ip}:${peer.port}` !== key);
	const complete = [...swarm.values()].filter((peer) => peer.left === 0).length;

	const reply = {
		interval: ANNOUNCE_INTERVAL,
		'min interval': ANNOUNCE_INTERVAL,
		complete,
		incomplete: swarm.size - complete,
	};

	// The compact form is what every client asks for, and `compact=0` is answered with
	// the dictionary form rather than refused: a tracker that returns a binary blob to a
	// client that asked for a list is parsed as one peer with an impossible address.
	if (decodeText(query.get('compact') || '1') === '0') {
		reply.peers = others.map((peer) => ({ ip: peer.ip, port: peer.port }));
	} else {
		reply.peers = Buffer.concat(others.map((peer) => {
			const packed = Buffer.alloc(6);

			// IPv4 only, which is all the lab bridge hands out. An IPv6 peer would have
			// to go in `peers6`, and there is no such peer here to test it with.
			peer.ip.split('.').forEach((octet, index) => packed.writeUInt8(Number(octet), index));
			packed.writeUInt16BE(peer.port, 4);

			return packed;
		}));
	}

	console.log(`announce ${hash.toString('hex').slice(0, 12)} ${event || 'update'} ${key}`
		+ ` -> ${others.length} peer(s), ${complete} seeding`);

	return bencode(reply);
}

function index(base) {
	const { announce, torrents } = manifest();
	const lines = releases.map((release) => {
		const torrent = torrents[release.key];

		if (!torrent) {
			return `  ${release.title}\n    not seeded yet — run docker/lab/seed-torrents.sh`;
		}

		return `  ${release.title}\n    magnet:?xt=urn:btih:${torrent.infoHash}`
			+ `&dn=${encodeURIComponent(torrent.name)}&tr=${encodeURIComponent(announce)}`;
	});

	return `${TITLE}\n\n`
		+ `  Torznab   ${base}/api?t=caps\n`
		+ `  Search    ${base}/api?t=search&q=expanse\n`
		+ `  Tracker   ${announce || 'unknown until the torrents are built'}\n\n`
		+ `${lines.join('\n')}\n`;
}

function send(response, status, type, body) {
	response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
	response.end(body);
}

http.createServer((request, response) => {
	const url = request.url || '/';
	const route = url.split('?')[0];
	const query = rawQuery(url);
	// The host the caller used, so the links work for whoever asked: Prowlarr reaches
	// this over the compose network as `fake-indexer:9117` and a human reaches it on
	// `localhost`, and a base URL fixed to either one is broken for the other. The
	// tracker address cannot be derived this way — it goes into the torrents, which are
	// read by containers — which is why it comes from the manifest instead.
	const base = `http://${request.headers.host || `localhost:${PORT}`}`;

	if (route === '/api' || route === '/api/') {
		const kind = decodeText(query.get('t') || '');

		if (kind === 'caps') {
			return send(response, 200, 'application/xml; charset=utf-8', caps());
		}

		if (kind === 'search') {
			return send(response, 200, 'application/rss+xml; charset=utf-8', feed(query, base, () => true));
		}

		if (kind === 'tvsearch' || kind === 'tv-search') {
			return send(response, 200, 'application/rss+xml; charset=utf-8',
				feed(query, base, (release) => release.category >= 5000 && release.category < 6000));
		}

		if (kind === 'movie' || kind === 'movie-search' || kind === 'moviesearch') {
			return send(response, 200, 'application/rss+xml; charset=utf-8',
				feed(query, base, (release) => release.category >= 2000 && release.category < 3000));
		}

		// 202 is the Newznab code for an unsupported function, and Prowlarr reports it as
		// such. Anything else here is reported as "indexer unavailable", which sends
		// whoever added the indexer looking at the network.
		return send(response, 200, 'application/xml; charset=utf-8', torznabError(202, `no such function: ${kind}`));
	}

	if (route.startsWith('/download/')) {
		const key = route.slice('/download/'.length).replace(/\.torrent$/, '');

		// The key is a file name taken from a URL, so it is checked against the fixture
		// rather than sanitised: anything not in the list cannot become a path at all.
		if (!releases.some((release) => release.key === key)) {
			return send(response, 404, 'text/plain; charset=utf-8', `no release ${key}\n`);
		}

		try {
			const body = fs.readFileSync(path.join(TORRENT_DIR, `${key}.torrent`));

			response.writeHead(200, {
				'Content-Type': 'application/x-bittorrent',
				'Content-Length': body.length,
				'Content-Disposition': `attachment; filename="${key}.torrent"`,
			});

			return response.end(body);
		} catch {
			return send(response, 404, 'text/plain; charset=utf-8',
				`${key} has no torrent file yet; run docker/lab/seed-torrents.sh\n`);
		}
	}

	if (route === '/announce') {
		const body = announceReply(query, request.socket.remoteAddress || '');

		response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });

		return response.end(body);
	}

	if (route === '/scrape') {
		const hash = decodeBytes(query.get('info_hash') || '');
		const swarm = hash.length === 20 ? peersFor(hash.toString('hex')) : new Map();
		const complete = [...swarm.values()].filter((peer) => peer.left === 0).length;

		// Assembled around `bencode` rather than through it: the key of the `files`
		// dictionary is the info hash itself, twenty raw bytes, and a JavaScript object
		// cannot hold a key that is not a string — the bytes over 0x7F would be re-encoded
		// as UTF-8 and the answer would name a torrent nobody asked about.
		const body = hash.length === 20
			? Buffer.concat([
				Buffer.from('d5:filesd'),
				bencode(hash),
				bencode({ complete, downloaded: complete, incomplete: swarm.size - complete }),
				Buffer.from('ee'),
			])
			: Buffer.from('d5:filesdee');

		response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });

		return response.end(body);
	}

	if (route === '/' || route === '/index.html') {
		return send(response, 200, 'text/plain; charset=utf-8', index(base));
	}

	return send(response, 404, 'text/plain; charset=utf-8', `nothing at ${route}\n`);
}).listen(PORT, () => {
	console.log(`${TITLE} on ${PORT}: ${releases.length} releases, torrents from ${TORRENT_DIR}`);
});
