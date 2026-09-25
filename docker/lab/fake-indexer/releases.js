/*
 * The fixture the lab's indexer serves, and the fixture its tracker seeds. One file,
 * because the two have to agree: a release whose torrent nobody seeds is a grab that
 * hangs forever at 0 %, and a torrent no release points at is dead weight nobody ever
 * downloads. `make-torrents.js` builds the content and the `.torrent` files from this
 * list, `server.js` answers searches from the same list, and neither knows anything the
 * other does not.
 *
 * Every entry exists to pin one thing the release parser has to get right. Do not
 * "tidy" a name: the dots, the missing separator before the group, the `E01-E03` run
 * and the misplaced `The` are the test. If a name here changes, a parser test changes
 * with it.
 *
 * The content behind the names is the lab media, unchanged — the same thirty seconds of
 * Big Buck Bunny `seed-media.sh` re-encodes under every title. Which file backs which
 * release is not arbitrary: a release that claims 2160p x265 is backed by a file that
 * really is 2160p x265, so a quality read off the stream and a quality read off the
 * name answer the same thing. A fixture where they disagreed would make the lab prove
 * the opposite of what it appears to prove.
 *
 * `seasons` and `episodes` are stated rather than parsed out of the title. The indexer
 * is the thing the parser is tested against; if it filtered `&season=`/`&ep=` by
 * parsing its own titles, a parser bug would hide itself by answering consistently on
 * both sides.
 */

// Newznab categories, which Prowlarr maps onto its own. 5000/2000 are the trees; the
// subcategory is what decides whether a UHD release is offered to a 1080p profile.
const TV_HD = 5040;
const TV_UHD = 5045;
const MOVIE_HD = 2040;
const MOVIE_UHD = 2045;

// Relative to the media root the lab generates, so this file never holds a path from
// anybody's workstation.
const SHOWS = 'library-b/shows';
const MOVIES = 'library-b/movies';

module.exports = [
	{
		// One episode, three times over, from three groups: the case the whole upgrade
		// path rests on. A parser that reads these as three different things, or as one,
		// breaks the same screen from two directions.
		key: 'expanse-s01e01-1080p-labteam',
		title: 'The.Expanse.S01E01.Dulcinea.1080p.BluRay.x265-LABTEAM',
		category: TV_HD,
		seasons: [1],
		episodes: [1],
		seeders: 24,
		leechers: 3,
		published: '2024-01-05T20:11:00Z',
		files: [
			{
				as: 'The.Expanse.S01E01.Dulcinea.1080p.BluRay.x265-LABTEAM.mp4',
				from: `${SHOWS}/The.Expanse.S01E02.The.Big.Empty.1080p.BluRay.x265-LAB.mp4`,
			},
		],
	},
	{
		// Free on this tracker's ratio, which is the one fact about a release that decides
		// whether somebody on a private tracker can take it at all. Here so that the chain
		// from a Torznab attribute to the chip on the row is proved rather than assumed.
		downloadFactor: 0,
		key: 'expanse-s01e01-2160p-labhd',
		title: 'The.Expanse.S01E01.Dulcinea.2160p.WEB-DL.x265-LABHD',
		category: TV_UHD,
		seasons: [1],
		episodes: [1],
		seeders: 9,
		leechers: 11,
		published: '2024-01-06T09:40:00Z',
		files: [
			{
				as: 'The.Expanse.S01E01.Dulcinea.2160p.WEB-DL.x265-LABHD.mp4',
				from: `${SHOWS}/The.Expanse.S01E04.CQB.2160p.BluRay.x265-LAB.mp4`,
			},
		],
	},
	{
		// Half price, because a screen that only knew "free" would call this full price.
		downloadFactor: 0.5,
		key: 'expanse-s01e01-720p-labrip',
		title: 'The.Expanse.S01E01.Dulcinea.720p.HDTV.x264-LABRIP',
		category: TV_HD,
		seasons: [1],
		episodes: [1],
		seeders: 2,
		leechers: 0,
		published: '2024-01-04T23:05:00Z',
		files: [
			{
				as: 'The.Expanse.S01E01.Dulcinea.720p.HDTV.x264-LABRIP.mp4',
				from: `${SHOWS}/The.Expanse.S01E01.Dulcinea.720p.WEB-DL.x264-LAB.mp4`,
			},
		],
	},
	{
		// A run of episodes in one grab. The interesting half is not the title but the
		// torrent: three files under one info hash, so whatever decides which file is
		// which episode has to read the file list rather than the release name.
		key: 'expanse-s01e01-e03-1080p',
		title: 'The.Expanse.S01E01-E03.1080p.BluRay.x264-LABTEAM',
		category: TV_HD,
		seasons: [1],
		episodes: [1, 2, 3],
		seeders: 15,
		leechers: 4,
		published: '2024-01-12T18:00:00Z',
		files: [
			{
				as: 'The.Expanse.S01E01.Dulcinea.1080p.BluRay.x264-LABTEAM.mp4',
				from: `${MOVIES}/Elephants.Dream.2006.1080p.x264-LAB.mp4`,
			},
			{
				as: 'The.Expanse.S01E02.The.Big.Empty.1080p.BluRay.x264-LABTEAM.mp4',
				from: `${MOVIES}/Elephants.Dream.2006.1080p.x264-LAB.mp4`,
			},
			{
				as: 'The.Expanse.S01E03.Remember.the.Cant.1080p.BluRay.x264-LABTEAM.mp4',
				from: `${MOVIES}/Elephants.Dream.2006.1080p.x264-LAB.mp4`,
			},
		],
	},
	{
		// A season pack, named the way trackers name them rather than the way a parser
		// would like: no episode number anywhere, and `COMPLETE` meaning "this season"
		// here and "every season" two entries down.
		key: 'expanse-s02-complete-1080p',
		title: 'The.Expanse.S02.COMPLETE.1080p.BluRay.x265-LABTEAM',
		category: TV_HD,
		seasons: [2],
		episodes: [],
		seeders: 31,
		leechers: 7,
		published: '2024-02-02T21:30:00Z',
		files: [
			{
				as: 'The.Expanse.S02E01.Safe.1080p.BluRay.x265-LABTEAM.mp4',
				from: `${SHOWS}/The.Expanse.S02E01.Safe.1080p.BluRay.x265-LAB.mp4`,
			},
			{
				as: 'The.Expanse.S02E02.Doors.and.Corners.1080p.BluRay.x265-LABTEAM.mp4',
				from: `${SHOWS}/The.Expanse.S01E02.The.Big.Empty.1080p.BluRay.x265-LAB.mp4`,
			},
			{
				as: 'The.Expanse.S02E03.Static.1080p.BluRay.x265-LABTEAM.mp4',
				from: `${SHOWS}/The.Expanse.S01E03.Remember.the.Cant.1080p.BluRay.x265-LAB.mp4`,
			},
		],
	},
	{
		// A whole series in one torrent, and the only entry whose files sit in
		// subdirectories. A grab that flattens the paths silently turns three episodes
		// into three files in one folder, which every media server then files wrong.
		key: 'cowboy-bebop-complete-2160p',
		title: 'Cowboy.Bebop.COMPLETE.SERIES.2160p.BluRay.x265-LABHD',
		category: TV_UHD,
		seasons: [1],
		episodes: [],
		seeders: 6,
		leechers: 19,
		published: '2024-03-18T12:45:00Z',
		files: [
			{
				as: 'Season 01/Cowboy.Bebop.S01E01.Asteroid.Blues.2160p.BluRay.x265-LABHD.mp4',
				from: `${SHOWS}/Cowboy.Bebop.S01E01.Asteroid.Blues.2160p.x265-LAB.mp4`,
			},
			{
				as: 'Season 01/Cowboy.Bebop.S01E02.Stray.Dog.Strut.2160p.BluRay.x265-LABHD.mp4',
				from: `${SHOWS}/Cowboy.Bebop.S01E01.Asteroid.Blues.2160p.x265-LAB.mp4`,
			},
			{
				as: 'Season 01/Cowboy.Bebop.S01E03.Honky.Tonk.Women.2160p.BluRay.x265-LABHD.mp4',
				from: `${SHOWS}/The.Expanse.S01E04.CQB.2160p.BluRay.x265-LAB.mp4`,
			},
		],
	},
	{
		// The show's article moved to the back, an `INTERNAL` tag in the middle of the
		// quality block and a group name that starts like a codec. It is the shape
		// `seed-media.sh` already put on disk, and the reason both exist is that a title
		// only normalises correctly if the search and the library agree on it.
		key: 'expanse-the-s01e05-internal',
		title: 'Expanse.The.S01E05.INTERNAL.1080p.x265-RELAB',
		category: TV_HD,
		seasons: [1],
		episodes: [5],
		seeders: 1,
		leechers: 0,
		published: '2024-01-20T04:15:00Z',
		files: [
			{
				as: 'Expanse.The.S01E05.INTERNAL.1080p.x265-RELAB.mp4',
				from: `${SHOWS}/Expanse.The.S01E05.INTERNAL.1080p.x265-RELAB.mp4`,
			},
		],
	},
	{
		// A film: a year where an episode has a season, and nothing else to go on.
		/*
		 * A release the tracker offers as a `.torrent` file and not as a magnet.
		 *
		 * Half the private trackers do exactly this, and it is a different chain: the
		 * client is handed a link and has to fetch it *itself*, from wherever it runs. A
		 * link built from the host the gateway asked on — which is what Prowlarr hands out
		 * — then resolves to the client's own container, and the add takes nothing while
		 * answering nothing. Here so that chain is exercised rather than assumed.
		 */
		torrentOnly: true,
		key: 'tears-of-steel-1080p',
		title: 'Tears.of.Steel.2012.1080p.BluRay.x265-LABTEAM',
		category: MOVIE_HD,
		seasons: [],
		episodes: [],
		seeders: 18,
		leechers: 2,
		published: '2024-01-09T14:00:00Z',
		files: [
			{
				as: 'Tears.of.Steel.2012.1080p.BluRay.x265-LABTEAM.mp4',
				from: `${MOVIES}/Tears.of.Steel.2012.1080p.x265-LAB.mp4`,
			},
		],
	},
	{
		// The second film is 2160p on purpose: a film category has its own resolution
		// ladder, and a profile that accepts UHD shows only here.
		key: 'big-buck-bunny-2160p',
		title: 'Big.Buck.Bunny.2008.2160p.BluRay.x265-LABHD',
		category: MOVIE_UHD,
		seasons: [],
		episodes: [],
		seeders: 42,
		leechers: 5,
		published: '2024-02-14T08:20:00Z',
		files: [
			{
				as: 'Big.Buck.Bunny.2008.2160p.BluRay.x265-LABHD.mp4',
				from: 'library-d/movies/Big.Buck.Bunny.2008.2160p.BluRay.x265-LAB.mp4',
			},
		],
	},
];
