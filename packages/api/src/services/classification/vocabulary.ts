/**
 * The words the detector recognises, and the shape of each list.
 *
 * Kept apart from the scoring so that the two arguments do not get mixed up. Adding a
 * studio is a change to what the gateway can see; changing a weight is a change to what
 * it is willing to say. The first happens often and is safe, the second happens rarely
 * and moves every proposal at once.
 *
 * Three matching disciplines are used and the distinction is load-bearing, because
 * choosing the wrong one is how a list starts firing on things it never meant to:
 *
 * - **whole words** for free text (titles, release names, path components). `phrase`
 *   matching anchors on word boundaries, so `docu` does not match `documentary` and
 *   `live` does not match `Olive`.
 * - **exact value** for structured fields (a genre, a studio, a language code). A studio
 *   field holds exactly `Bones`, so exact comparison lets a list carry a word that would
 *   be reckless as a substring — which is most of the interesting studio names. Genres are
 *   compared this way for a sharper reason: a media server lists them one per entry, and
 *   whole-word containment read the French `Dessin animé` as the Japanese `Anime`, because
 *   `anime` is a word inside it. That is the wrong shelf for every French-configured
 *   library in the house, reached through a list that looked obviously correct.
 * - **bracketed token** for release names, where a group is `[SubsPlease]`, `(Judas)`
 *   or a trailing `-Erai-raws` rather than a word in a sentence.
 */

import { foldAccents } from '../title-normalizer';

/** Case, accents and punctuation gone, runs of space collapsed. */
export const fold = (value: string): string =>
	foldAccents(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

/**
 * Whether a folded haystack contains a phrase as whole words.
 *
 * Padding both sides with a space is the whole trick, and it is why this is a function
 * rather than an `includes` at each call site: `' ' + 'live at wembley' + ' '` contains
 * `' live at '` and does not contain `' olive '`. A regular expression would need the
 * phrase escaped, and a phrase list nobody escapes is a list where somebody's `J.C.Staff`
 * quietly becomes a wildcard.
 */
export const containsPhrase = (folded: string, phrase: string): boolean =>
	` ${folded} `.includes(` ${phrase} `);

/** The first phrase of the list this text contains, or null. */
export const firstPhrase = (folded: string, phrases: readonly string[]): string | null =>
	phrases.find((phrase) => containsPhrase(folded, phrase)) ?? null;

/** Whether a structured field is exactly one of these values, once folded. */
export const isOneOf = (folded: string, values: readonly string[]): boolean =>
	values.some((value) => value === folded);

/**
 * Genres that name Japanese animation outright.
 *
 * The demographics and the format words are here for the same reason the word `anime`
 * is: a library that carries `Shounen` is a library whose scraper has already decided
 * this is Japanese animation, and there is no more authoritative source available to
 * the gateway. `Isekai` and `Mecha` are genres no western studio's metadata uses.
 */
export const ANIME_GENRES = [
	'anime',
	'animes',
	'japanese animation',
	'animation japonaise',
	'japanimation',
	'shounen',
	'shonen',
	'shoujo',
	'shojo',
	'seinen',
	'josei',
	'isekai',
	'mecha',
	'iyashikei',
] as const;

/**
 * Genres that say animation without saying where it came from.
 *
 * Several languages, because the genre string is whatever the media server was
 * configured in and a French Jellyfin says `Dessin animé`. Missing one costs a category
 * the gateway cannot see at all, which is a silent loss rather than a wrong guess.
 */
export const ANIMATION_GENRES = [
	'animation',
	'animated',
	'cartoon',
	'cartoons',
	'dessin anime',
	'dessins animes',
	'zeichentrick',
	'animacion',
	'animazione',
] as const;

/**
 * Genres that count against every category here.
 *
 * Both cases this exists for were real wrong guesses: a documentary *about* anime
 * carries `Animation` because of its animated inserts, and a concert film carries
 * `Music` and `Documentary` together. In both the documentary is the thing it is, and
 * the shelf it belongs on is not one of the four.
 */
export const DOCUMENTARY_GENRES = [
	'documentary',
	'documentaire',
	'dokumentarfilm',
	'dokumentation',
	'documental',
	'documentario',
] as const;

/** Genres that name a recorded performance rather than music in general. */
export const CONCERT_GENRES = [
	'concert',
	'concerts',
	'live performance',
	'live music',
	'spectacle',
	'konzert',
] as const;

/**
 * Music genres, which is usually all a concert recording carries.
 *
 * `Musical` is deliberately absent. A musical is a film with songs in it, and reading it
 * as a recorded performance would put *La La Land* on the concerts shelf — one of the
 * cheapest wrong proposals available, and one that would be made on thousands of rows.
 */
export const MUSIC_GENRES = ['music', 'musique', 'musik', 'musica'] as const;

/**
 * What a recorded performance calls itself.
 *
 * `live at` and `live from` are close to conclusive; `tour` is absent because *The Grand
 * Tour* and *Tour de France* are both in ordinary libraries, and a signal that fires on
 * them teaches people to stop reading proposals.
 */
export const LIVE_PERFORMANCE_PHRASES = [
	'live at',
	'live from',
	'live in',
	'live aus',
	// `live au Zénith`, and no bare `live a`: it would fire on `Live a Little`.
	'live au',
	'in concert',
	'en concert',
	'concert',
	'konzert',
	'unplugged',
	'live session',
	'live show',
] as const;

/**
 * Venues and festivals, which is the other thing a performance names.
 *
 * Corroborating only, and it has to be: `Olympia` is a city, a film and a hall, and
 * `Woodstock` is a town. Beside a concert genre or a `live at` it is what makes the
 * proposal obviously right to whoever reads it; on its own it means nothing.
 */
export const VENUES = [
	'wembley',
	'madison square garden',
	'royal albert hall',
	'carnegie hall',
	'hollywood bowl',
	'red rocks',
	'budokan',
	'olympia',
	'bercy',
	'accor arena',
	'zenith',
	'stade de france',
	'o2 arena',
	'sydney opera house',
	'glastonbury',
	'hyde park',
	'montreux',
	'woodstock',
	'rock am ring',
	'coachella',
	'lollapalooza',
	'wacken',
	'donington',
	'pinkpop',
	'roskilde',
	'rock en seine',
	'vieilles charrues',
	'paleo',
	'werchter',
] as const;

/**
 * Studios that make Japanese animation, matched on the whole field.
 *
 * Exact comparison is what makes this list possible. `Bones`, `Trigger`, `Orange` and
 * `Feel` are real studios and reckless substrings — `Bones` would fire on every episode
 * of a forensics procedural. A studio field holds the studio's name and nothing else, so
 * comparing the whole value is both safer and more honest about what is being claimed.
 */
export const JAPANESE_ANIMATION_STUDIOS = [
	'studio ghibli',
	'ghibli',
	'toei animation',
	'toei',
	'madhouse',
	'mappa',
	'ufotable',
	'kyoto animation',
	'kyoani',
	'production i g',
	'bones',
	'studio bones',
	'sunrise',
	'bandai namco filmworks',
	'shaft',
	'a 1 pictures',
	'cloverworks',
	'wit studio',
	'trigger',
	'studio trigger',
	'gainax',
	'khara',
	'studio khara',
	'pierrot',
	'studio pierrot',
	'gonzo',
	'j c staff',
	'p a works',
	'david production',
	'silver link',
	'satelight',
	'tatsunoko production',
	'nippon animation',
	'tms entertainment',
	'olm',
	'white fox',
	'doga kobo',
	'lerche',
	'science saru',
	'orange',
	'polygon pictures',
	'xebec',
	'seven arcs',
	'zexcs',
	'manglobe',
	'brain s base',
	'shin ei animation',
	'studio deen',
	'feel',
	'kinema citrus',
] as const;

/**
 * Studios that make animation and are not Japanese.
 *
 * The distinction from the list above is the whole anime-versus-cartoons tie-break, and
 * it is the reason there are two lists rather than one with a flag: a studio moving from
 * one to the other is a claim about origin, and it should read as one in the diff.
 */
export const ANIMATION_STUDIOS = [
	'walt disney animation studios',
	'disney television animation',
	'pixar',
	'pixar animation studios',
	'dreamworks animation',
	'illumination',
	'illumination entertainment',
	'illumination mac guff',
	'blue sky studios',
	'sony pictures animation',
	'warner bros animation',
	'warner animation group',
	'cartoon network studios',
	'nickelodeon animation studio',
	'hanna barbera',
	'aardman',
	'aardman animations',
	'laika',
	'cartoon saloon',
	'titmouse',
	'bento box entertainment',
	'rough draft studios',
	'klasky csupo',
	'xilam',
	'xilam animation',
	'folimage',
	'ellipse animation',
	'gaumont animation',
	'method animation',
	'mikros animation',
	'blue spirit',
	'studio 100 animation',
	'la cachette',
	'fortiche production',
] as const;

/**
 * Groups that subtitle nothing but anime, matched as a release token.
 *
 * Close to conclusive, which is why it is a decisive signal rather than a hint: none of
 * these has ever released a live-action film. It matters most for the case the index is
 * otherwise blind to — a file that arrived from a tracker, whose only metadata is its
 * own name.
 */
export const FANSUB_GROUPS = [
	'subsplease',
	'horriblesubs',
	'erai raws',
	'ohys raws',
	'beatrice raws',
	'judas',
	'asw',
	'ember',
	'commie',
	'gjm',
	'cerberus',
	'golumpa',
	'doki',
	'coalgirls',
	'yameii',
	'mtbb',
	'anime time',
	'animetime',
	'sallysubs',
	'vostfree',
	'wakanim',
	'nep blanc',
	'cleo',
	'kaleido',
] as const;

/** Folder names that say which shelf a file is on, or was staged for. */
export const ANIMATION_PATH_KEYWORDS = [
	'anime',
	'animes',
	'animation',
	'animations',
	'cartoon',
	'cartoons',
	'dessin anime',
	'dessins animes',
	'japanim',
	'japanimation',
] as const;

/** The same, for performances. */
export const CONCERT_PATH_KEYWORDS = [
	'concert',
	'concerts',
	'konzert',
	'spectacle',
	'spectacles',
	'live',
	'lives',
] as const;

/**
 * Language values that mean Japanese, however the service spells them.
 *
 * Exact comparison on the whole field: `ja` must not match every title containing those
 * two letters, and `jp` is not a valid ISO code but is what several services send.
 */
export const JAPANESE_LANGUAGES = ['ja', 'jpn', 'jp', 'japanese', 'japonais'] as const;

/** Country values that mean Japan. Exact, for the reason above. */
export const JAPANESE_COUNTRIES = ['jp', 'jpn', 'japan', 'japon'] as const;

/**
 * Words that make a romanised title read as Japanese.
 *
 * Every one is at least five letters and none is a word of English, French or Spanish,
 * and that bar is the point. The particles — `no`, `wa`, `ga`, `ni` — are what a
 * romanised Japanese title is actually full of, and every one of them is also an
 * ordinary English word: `No Country for Old Men` and `Ni No Kuni` cannot be told apart
 * by a particle. Including them was tried and rejected; the genitive pattern `X no Y`
 * was rejected with them, for the same reason.
 *
 * So this list is deliberately narrow, deliberately incomplete, and deliberately unable
 * to decide anything by itself. It exists to *corroborate* a genre, and to make the
 * anime-versus-cartoons question visibly unanswerable when it is the only origin signal
 * there is.
 */
export const ROMANISED_JAPANESE_TOKENS = [
	'monogatari',
	'gakuen',
	'sensei',
	'senpai',
	'sempai',
	'densetsu',
	'yuusha',
	'mahou',
	'shinobi',
	'kyojin',
	'kyoujin',
	'shingeki',
	'seishun',
	'kanojo',
	'gaiden',
	'jigoku',
	'tenshi',
	'akuma',
	'youkai',
	'yokai',
	'kaijuu',
	'shounen',
	'shoujo',
	'tsukai',
	'hitori',
	'watashi',
	'sekai',
	'tenkuu',
	'majutsu',
	'kishi',
	'hime',
	'majo',
	'yume',
	'hoshi',
	'kimi',
	'boku',
] as const;
