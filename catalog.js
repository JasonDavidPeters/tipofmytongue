/**
 * catalog.js — Deezer ingestion engine v4  (Strict Mode)
 *
 * Core guarantees:
 *  1. `artist` column always contains the REAL original artist, never a
 *     karaoke publisher. If we cannot extract the real artist, the track
 *     is REJECTED.
 *  2. Every source has an explicit decade_min / decade_max window.
 *     Tracks whose release year falls outside that window are REJECTED —
 *     no "2000s R&B" track can sneak into the 90s bucket.
 *  3. Sources with artist_lock only accept tracks attributed to that exact
 *     artist. A Shania Twain source will never insert an Ed Sheeran track.
 *  4. Mashups, medleys, compilations and multi-song tracks are rejected.
 *  5. Instrumental filter: title or title_version must confirm vocal-free.
 */

const pool = require('./db');

// ─── Instrumental keyword filter ──────────────────────────────────────────────
const INSTRUMENTAL_KEYWORDS = [
  'instrumental', 'karaoke', 'backing track', 'backing version',
  'minus one', 'no vocal', 'no voice', 'music only',
  'piano version', 'orchestra version', 'orchestral version',
  'acoustic instrumental', 'in the style of', 'tribute instrumental',
];
function isInstrumental(track) {
  const v = (track.title_version || '').toLowerCase();
  const t = (track.title        || '').toLowerCase();
  return INSTRUMENTAL_KEYWORDS.some(kw => v.includes(kw) || t.includes(kw));
}

// ─── Mashup / compilation rejection ──────────────────────────────────────────
const REJECT_PATTERNS = [
  /\bmedley\b/i, /\bmegamix\b/i, /\bmashup\b/i, /\bmash.?up\b/i,
  /\bcollection\b/i, /\bcompilation\b/i,
  /\d+\s+(hits|songs|classics)\s+in\s+\d+/i,
  /\bnon.?stop\b/i, /\bparty\s+mix\b/i, /\bkaraoke\s+megamix\b/i,
];
function isRejectedTitle(title) {
  return REJECT_PATTERNS.some(p => p.test(title));
}

// ─── Duration filter ──────────────────────────────────────────────────────────
function hasSensibleDuration(track) {
  const d = track.duration || 0;
  return d >= 60 && d <= 600;
}

// ─── Title cleaning ───────────────────────────────────────────────────────────
const TITLE_STRIP = [
  /\s*\(originally performed by[^)]*\)/gi,
  /\s*\(originally recorded by[^)]*\)/gi,
  /\s*\(originally popularized by[^)]*\)/gi,
  /\s*\(made famous by[^)]*\)/gi,
  /\s*\(as made famous by[^)]*\)/gi,
  /\s*\(as performed by[^)]*\)/gi,
  /\s*\(in the style of[^)]*\)/gi,
  /\s*\(tribute to[^)]*\)/gi,
  /\s*\(karaoke[^)]*\)/gi,
  /\s*\(instrumental[^)]*\)/gi,
  /\s*\(backing track[^)]*\)/gi,
  /\s*\(piano[^)]*\)/gi,
  /\s*\(minus one[^)]*\)/gi,
  /\s*\(no vocal[^)]*\)/gi,
  /\s*\(cover[^)]*\)/gi,
  /\s*\(without vocals[^)]*\)/gi,
  /\s*\[originally[^\]]*\]/gi,
  /\s*\[in the style[^\]]*\]/gi,
  /\s*\[karaoke[^\]]*\]/gi,
  /\s*\[instrumental[^\]]*\]/gi,
  /\s*[-\u2013]\s*(karaoke|instrumental|backing track|piano version|minus one|in the style of)[^\n]*/gi,
  /^(instrumental|karaoke)[:\s]+/gi,
];
function cleanTitle(raw) {
  let s = raw || '';
  for (const p of TITLE_STRIP) s = s.replace(p, '');
  return s.trim();
}
function extractRealTitle(track) {
  const shortClean = cleanTitle(track.title_short || '');
  if (shortClean.length > 1) return shortClean;
  return cleanTitle(track.title || '');
}

// ─── Artist extraction ────────────────────────────────────────────────────────
// Priority order — first match wins.
const ARTIST_PATTERNS = [
  /originally performed by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /originally recorded by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /originally popularized by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /originally by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /made famous by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /as made famous by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /as performed by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /in the style of\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /tribute to\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /\[([^\]]+?)\s+karaoke]/i,
  /\(([^)]+?)\s+karaoke\)/i,
];

function extractOriginalArtist(track) {
  // Try the full title first (has the most publisher metadata)
  const fullTitle = track.title || '';
  for (const pattern of ARTIST_PATTERNS) {
    const m = fullTitle.match(pattern);
    if (m) {
      const artist = m[1]
        .replace(/\s*[-\u2013]\s*(karaoke|instrumental|version|track|vocal).*/i, '')
        .replace(/\s*\(.*\)$/, '')
        .trim();
      if (artist.length > 1 && artist.length < 60) return artist;
    }
  }
  return null;
}

// ─── Release year extraction ──────────────────────────────────────────────────
function releaseYear(track) {
  const d = track.album && track.album.release_date;
  if (!d) return null;
  const y = parseInt(d.slice(0, 4));
  return isNaN(y) ? null : y;
}

// ─── Era from year ────────────────────────────────────────────────────────────
function eraFromYear(year) {
  if (!year) return 'modern';
  if (year < 1980) return '60s70s';
  if (year < 2000) return '80s90s';
  if (year < 2010) return '2000s';
  return 'modern';
}

// ─── Artist normaliser (for artist_lock comparison) ───────────────────────────
function normArtist(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\bthe\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Sources ──────────────────────────────────────────────────────────────────
// Each source must declare:
//   query        — Deezer search string
//   genre        — DB genre tag
//   era          — DB era tag (must align with decade_min/decade_max)
//   decade_min   — inclusive lower bound (release year)
//   decade_max   — inclusive upper bound (release year)
//   label        — human-readable for logs
//
// Optional:
//   artist_lock  — if set, extracted artist MUST fuzzy-match this string
//                  (used for single-artist genre categories)

const SOURCES = [

  // ════════════════════════════════════════════════════════════════════════════
  // POP
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Karaoke Hits pop 2010s',          genre:'pop',         era:'modern',  decade_min:2010, decade_max:2029, label:'Pop 2010s'           },
  { query: 'Karaoke Hits pop 2020s',          genre:'pop',         era:'modern',  decade_min:2020, decade_max:2029, label:'Pop 2020s'           },
  { query: 'Karaoke Hits pop 2000s',          genre:'pop',         era:'2000s',   decade_min:2000, decade_max:2009, label:'Pop 2000s'           },
  { query: 'Karaoke Hits pop 90s',            genre:'pop',         era:'80s90s',  decade_min:1990, decade_max:1999, label:'Pop 90s'             },
  { query: 'Karaoke Hits pop 80s',            genre:'pop',         era:'80s90s',  decade_min:1980, decade_max:1989, label:'Pop 80s'             },
  { query: 'Taylor Swift karaoke instrumental', genre:'pop', era:'modern', decade_min:2006, decade_max:2029, label:'Taylor Swift 1', artist_lock:'Taylor Swift' },
  { query: 'Taylor Swift karaoke',              genre:'pop', era:'modern', decade_min:2006, decade_max:2029, label:'Taylor Swift 2', artist_lock:'Taylor Swift' },
  { query: 'Taylor Swift backing track',        genre:'pop', era:'modern', decade_min:2006, decade_max:2029, label:'Taylor Swift 3', artist_lock:'Taylor Swift' },
  { query: '"Taylor Swift" instrumental',       genre:'pop', era:'modern', decade_min:2006, decade_max:2029, label:'Taylor Swift 4', artist_lock:'Taylor Swift' },

  { query: 'Adele karaoke instrumental',        genre:'pop', era:'modern', decade_min:2008, decade_max:2029, label:'Adele 1',         artist_lock:'Adele' },
  { query: 'Adele karaoke',                     genre:'pop', era:'modern', decade_min:2008, decade_max:2029, label:'Adele 2',         artist_lock:'Adele' },
  { query: 'Adele backing track instrumental',  genre:'pop', era:'modern', decade_min:2008, decade_max:2029, label:'Adele 3',         artist_lock:'Adele' },

  { query: 'Ed Sheeran karaoke instrumental',   genre:'pop', era:'modern', decade_min:2011, decade_max:2029, label:'Ed Sheeran 1',    artist_lock:'Ed Sheeran' },
  { query: 'Ed Sheeran karaoke',                genre:'pop', era:'modern', decade_min:2011, decade_max:2029, label:'Ed Sheeran 2',    artist_lock:'Ed Sheeran' },
  { query: 'Ed Sheeran backing track',          genre:'pop', era:'modern', decade_min:2011, decade_max:2029, label:'Ed Sheeran 3',    artist_lock:'Ed Sheeran' },

  { query: 'Bruno Mars karaoke instrumental',   genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Bruno Mars 1',    artist_lock:'Bruno Mars' },
  { query: 'Bruno Mars karaoke',                genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Bruno Mars 2',    artist_lock:'Bruno Mars' },
  { query: 'Bruno Mars backing track',          genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Bruno Mars 3',    artist_lock:'Bruno Mars' },

  { query: 'Billie Eilish karaoke instrumental',genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Billie Eilish 1', artist_lock:'Billie Eilish' },
  { query: 'Billie Eilish karaoke',             genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Billie Eilish 2', artist_lock:'Billie Eilish' },
  { query: 'Billie Eilish backing track',       genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Billie Eilish 3', artist_lock:'Billie Eilish' },

  { query: 'Olivia Rodrigo karaoke',            genre:'pop', era:'modern', decade_min:2021, decade_max:2029, label:'Olivia Rodrigo 1',artist_lock:'Olivia Rodrigo' },
  { query: 'Olivia Rodrigo karaoke instrumental',genre:'pop',era:'modern', decade_min:2021, decade_max:2029, label:'Olivia Rodrigo 2',artist_lock:'Olivia Rodrigo' },

  { query: 'Dua Lipa karaoke instrumental',     genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Dua Lipa 1',      artist_lock:'Dua Lipa' },
  { query: 'Dua Lipa karaoke',                  genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Dua Lipa 2',      artist_lock:'Dua Lipa' },
  { query: 'Dua Lipa backing track',            genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Dua Lipa 3',      artist_lock:'Dua Lipa' },

  { query: 'Harry Styles karaoke instrumental', genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Harry Styles 1',  artist_lock:'Harry Styles' },
  { query: 'Harry Styles karaoke',              genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Harry Styles 2',  artist_lock:'Harry Styles' },

  { query: 'Ariana Grande karaoke instrumental',genre:'pop', era:'modern', decade_min:2013, decade_max:2029, label:'Ariana Grande 1', artist_lock:'Ariana Grande' },
  { query: 'Ariana Grande karaoke',             genre:'pop', era:'modern', decade_min:2013, decade_max:2029, label:'Ariana Grande 2', artist_lock:'Ariana Grande' },
  { query: 'Ariana Grande backing track',       genre:'pop', era:'modern', decade_min:2013, decade_max:2029, label:'Ariana Grande 3', artist_lock:'Ariana Grande' },

  { query: 'Justin Bieber karaoke instrumental',genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Justin Bieber 1', artist_lock:'Justin Bieber' },
  { query: 'Justin Bieber karaoke',             genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Justin Bieber 2', artist_lock:'Justin Bieber' },
  { query: 'Justin Bieber backing track',       genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Justin Bieber 3', artist_lock:'Justin Bieber' },
  { query: 'Lady Gaga karaoke instrumental',  genre:'pop',         era:'2000s',   decade_min:2008, decade_max:2015, label:'Lady Gaga',           artist_lock:'Lady Gaga'       },
  { query: 'Beyonce karaoke instrumental',    genre:'pop',         era:'2000s',   decade_min:2003, decade_max:2016, label:'Beyonce Pop',         artist_lock:'Beyonce'         },
  { query: 'Rihanna karaoke instrumental',    genre:'pop',         era:'2000s',   decade_min:2005, decade_max:2016, label:'Rihanna',             artist_lock:'Rihanna'         },
  { query: 'Britney Spears karaoke',          genre:'pop',         era:'2000s',   decade_min:1998, decade_max:2011, label:'Britney Spears',      artist_lock:'Britney Spears'  },
  { query: 'Justin Timberlake karaoke',       genre:'pop',         era:'2000s',   decade_min:2002, decade_max:2018, label:'Justin Timberlake',   artist_lock:'Justin Timberlake'},
  { query: 'Backstreet Boys karaoke',         genre:'pop',         era:'80s90s',  decade_min:1996, decade_max:2005, label:'Backstreet Boys',     artist_lock:'Backstreet Boys' },
  { query: 'NSYNC karaoke instrumental',      genre:'pop',         era:'80s90s',  decade_min:1996, decade_max:2002, label:'NSYNC',               artist_lock:'NSYNC'           },
  { query: 'Spice Girls karaoke',             genre:'pop',         era:'80s90s',  decade_min:1996, decade_max:2001, label:'Spice Girls',         artist_lock:'Spice Girls'     },
  { query: 'ABBA karaoke instrumental',       genre:'pop',         era:'60s70s',  decade_min:1972, decade_max:1982, label:'ABBA',                artist_lock:'ABBA'            },
  { query: 'Elton John karaoke instrumental', genre:'pop',         era:'60s70s',  decade_min:1970, decade_max:1990, label:'Elton John',          artist_lock:'Elton John'      },
  { query: 'Madonna karaoke instrumental',    genre:'pop',         era:'80s90s',  decade_min:1983, decade_max:2000, label:'Madonna',             artist_lock:'Madonna'         },

  // ════════════════════════════════════════════════════════════════════════════
  // ROCK
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Karaoke Hits rock 90s',           genre:'rock',        era:'80s90s',  decade_min:1990, decade_max:1999, label:'Rock 90s'            },
  { query: 'Karaoke Hits rock 80s',           genre:'rock',        era:'80s90s',  decade_min:1980, decade_max:1989, label:'Rock 80s'            },
  { query: 'Karaoke Hits rock 2000s',         genre:'rock',        era:'2000s',   decade_min:2000, decade_max:2009, label:'Rock 2000s'          },
  { query: 'Guns N Roses karaoke',            genre:'rock',        era:'80s90s',  decade_min:1987, decade_max:1999, label:'Guns N Roses',        artist_lock:"Guns N' Roses"   },
  { query: 'Bon Jovi karaoke instrumental',   genre:'rock',        era:'80s90s',  decade_min:1984, decade_max:2000, label:'Bon Jovi',            artist_lock:'Bon Jovi'        },
  { query: 'U2 karaoke instrumental',         genre:'rock',        era:'80s90s',  decade_min:1980, decade_max:2005, label:'U2',                  artist_lock:'U2'              },
  { query: 'Nirvana karaoke instrumental',    genre:'rock',        era:'80s90s',  decade_min:1989, decade_max:1999, label:'Nirvana',             artist_lock:'Nirvana'         },
  { query: 'Pearl Jam karaoke instrumental',  genre:'rock',        era:'80s90s',  decade_min:1991, decade_max:2002, label:'Pearl Jam',           artist_lock:'Pearl Jam'       },
  { query: 'Oasis karaoke instrumental',      genre:'rock',        era:'80s90s',  decade_min:1994, decade_max:2009, label:'Oasis',               artist_lock:'Oasis'           },
  { query: 'Green Day karaoke instrumental',  genre:'rock',        era:'2000s',   decade_min:1994, decade_max:2012, label:'Green Day',           artist_lock:'Green Day'       },
  { query: 'Coldplay karaoke instrumental',   genre:'rock',        era:'2000s',   decade_min:2000, decade_max:2015, label:'Coldplay',            artist_lock:'Coldplay'        },
  { query: 'Foo Fighters karaoke',            genre:'rock',        era:'2000s',   decade_min:1995, decade_max:2015, label:'Foo Fighters',        artist_lock:'Foo Fighters'    },

  // ════════════════════════════════════════════════════════════════════════════
  // CLASSIC ROCK (60s / 70s)
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Queen karaoke instrumental',           genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1991, label:'Queen 1',   artist_lock:'Queen' },
  { query: 'Queen karaoke',                        genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1991, label:'Queen 2',   artist_lock:'Queen' },
  { query: 'Queen backing track',                  genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1991, label:'Queen 3',   artist_lock:'Queen' },
  { query: '"Queen" instrumental rock',            genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1991, label:'Queen 4',   artist_lock:'Queen' },

  { query: 'Beatles karaoke instrumental',         genre:'classic-rock', era:'60s70s', decade_min:1963, decade_max:1970, label:'Beatles 1', artist_lock:'Beatles' },
  { query: 'Beatles karaoke',                      genre:'classic-rock', era:'60s70s', decade_min:1963, decade_max:1970, label:'Beatles 2', artist_lock:'Beatles' },
  { query: 'Beatles backing track',                genre:'classic-rock', era:'60s70s', decade_min:1963, decade_max:1970, label:'Beatles 3', artist_lock:'Beatles' },
  { query: 'Led Zeppelin karaoke instrumental',genre:'classic-rock',era:'60s70s', decade_min:1968, decade_max:1982, label:'Led Zeppelin',       artist_lock:'Led Zeppelin'    },
  { query: 'Rolling Stones karaoke',         genre:'classic-rock', era:'60s70s',  decade_min:1963, decade_max:1982, label:'Rolling Stones',     artist_lock:'Rolling Stones'  },
  { query: 'Fleetwood Mac karaoke',          genre:'classic-rock', era:'60s70s',  decade_min:1968, decade_max:1990, label:'Fleetwood Mac',      artist_lock:'Fleetwood Mac'   },
  { query: 'Eagles karaoke instrumental',    genre:'classic-rock', era:'60s70s',  decade_min:1972, decade_max:1982, label:'Eagles',             artist_lock:'Eagles'          },
  { query: 'David Bowie karaoke instrumental',genre:'classic-rock',era:'60s70s',  decade_min:1969, decade_max:1990, label:'David Bowie',        artist_lock:'David Bowie'     },
  { query: 'Pink Floyd karaoke instrumental', genre:'classic-rock', era:'60s70s', decade_min:1967, decade_max:1983, label:'Pink Floyd',         artist_lock:'Pink Floyd'      },
  { query: 'Jimi Hendrix karaoke instrumental',genre:'classic-rock',era:'60s70s', decade_min:1966, decade_max:1971, label:'Jimi Hendrix',      artist_lock:'Jimi Hendrix'    },
  { query: 'Aerosmith karaoke instrumental',  genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1999, label:'Aerosmith',         artist_lock:'Aerosmith'       },
  { query: 'AC/DC karaoke instrumental',      genre:'classic-rock', era:'60s70s', decade_min:1975, decade_max:1995, label:'AC/DC',             artist_lock:'AC/DC'           },
  { query: 'Bruce Springsteen karaoke',       genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1995, label:'Bruce Springsteen', artist_lock:'Bruce Springsteen'},
  { query: 'Van Halen karaoke instrumental',  genre:'classic-rock', era:'80s90s', decade_min:1978, decade_max:1995, label:'Van Halen',         artist_lock:'Van Halen'       },

  // ════════════════════════════════════════════════════════════════════════════
  // HIP-HOP (2000s+)
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Eminem karaoke instrumental',     genre:'hip-hop',     era:'2000s',   decade_min:1999, decade_max:2013, label:'Eminem',              artist_lock:'Eminem'          },
  { query: 'Drake karaoke instrumental',      genre:'hip-hop',     era:'modern',  decade_min:2009, decade_max:2029, label:'Drake',               artist_lock:'Drake'           },
  { query: 'Kanye West karaoke instrumental', genre:'hip-hop',     era:'2000s',   decade_min:2004, decade_max:2016, label:'Kanye West',          artist_lock:'Kanye West'      },
  { query: 'Jay Z karaoke instrumental',      genre:'hip-hop',     era:'2000s',   decade_min:1996, decade_max:2014, label:'Jay-Z',               artist_lock:'Jay-Z'           },
  { query: 'Kendrick Lamar karaoke',          genre:'hip-hop',     era:'modern',  decade_min:2011, decade_max:2029, label:'Kendrick Lamar',      artist_lock:'Kendrick Lamar'  },
  { query: 'Post Malone karaoke',             genre:'hip-hop',     era:'modern',  decade_min:2016, decade_max:2029, label:'Post Malone',         artist_lock:'Post Malone'     },
  { query: 'Lil Nas X karaoke',              genre:'hip-hop',     era:'modern',  decade_min:2018, decade_max:2029, label:'Lil Nas X',           artist_lock:'Lil Nas X'       },

  // ════════════════════════════════════════════════════════════════════════════
  // 90s RAP
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Tupac karaoke instrumental',      genre:'90s-rap',     era:'80s90s',  decade_min:1991, decade_max:1999, label:'Tupac',               artist_lock:'2Pac'            },
  { query: 'Biggie Smalls karaoke instrumental',genre:'90s-rap',   era:'80s90s',  decade_min:1994, decade_max:1999, label:'Biggie',              artist_lock:'Notorious B.I.G' },
  { query: 'Snoop Dogg 90s karaoke instrumental',genre:'90s-rap',  era:'80s90s',  decade_min:1993, decade_max:1999, label:'Snoop Dogg 90s',     artist_lock:'Snoop Dogg'      },
  { query: 'Dr Dre karaoke instrumental 90s', genre:'90s-rap',     era:'80s90s',  decade_min:1992, decade_max:1999, label:'Dr Dre',              artist_lock:'Dr. Dre'         },
  { query: 'Nas karaoke instrumental',        genre:'90s-rap',     era:'80s90s',  decade_min:1994, decade_max:2001, label:'Nas',                 artist_lock:'Nas'             },
  { query: 'DMX karaoke instrumental',        genre:'90s-rap',     era:'80s90s',  decade_min:1998, decade_max:2003, label:'DMX',                 artist_lock:'DMX'             },
  { query: 'Coolio karaoke instrumental',     genre:'90s-rap',     era:'80s90s',  decade_min:1994, decade_max:2001, label:'Coolio',              artist_lock:'Coolio'          },
  { query: 'Missy Elliott karaoke',           genre:'90s-rap',     era:'80s90s',  decade_min:1997, decade_max:2006, label:'Missy Elliott',       artist_lock:'Missy Elliott'   },
  { query: 'TLC karaoke instrumental',        genre:'90s-rap',     era:'80s90s',  decade_min:1992, decade_max:2002, label:'TLC',                 artist_lock:'TLC'             },
  { query: 'Warren G karaoke instrumental',   genre:'90s-rap',     era:'80s90s',  decade_min:1994, decade_max:2001, label:'Warren G',            artist_lock:'Warren G'        },

  // ════════════════════════════════════════════════════════════════════════════
  // R&B / SOUL
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Whitney Houston karaoke',         genre:'rnb',         era:'80s90s',  decade_min:1985, decade_max:2009, label:'Whitney Houston',     artist_lock:'Whitney Houston' },
  { query: 'Mariah Carey karaoke',            genre:'rnb',         era:'80s90s',  decade_min:1990, decade_max:2005, label:'Mariah Carey',        artist_lock:'Mariah Carey'    },
  { query: 'Usher karaoke instrumental',      genre:'rnb',         era:'2000s',   decade_min:1997, decade_max:2012, label:'Usher',               artist_lock:'Usher'           },
  { query: 'Alicia Keys karaoke',             genre:'rnb',         era:'2000s',   decade_min:2001, decade_max:2016, label:'Alicia Keys',         artist_lock:'Alicia Keys'     },
  { query: 'Amy Winehouse karaoke',           genre:'rnb',         era:'2000s',   decade_min:2003, decade_max:2011, label:'Amy Winehouse',       artist_lock:'Amy Winehouse'   },
  { query: 'The Weeknd karaoke',              genre:'rnb',         era:'modern',  decade_min:2012, decade_max:2029, label:'The Weeknd',          artist_lock:'The Weeknd'      },
  { query: 'SZA karaoke instrumental',        genre:'rnb',         era:'modern',  decade_min:2017, decade_max:2029, label:'SZA',                 artist_lock:'SZA'             },

  // ════════════════════════════════════════════════════════════════════════════
  // SOUL / MOTOWN (classic)
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Aretha Franklin karaoke',         genre:'soul',        era:'60s70s',  decade_min:1960, decade_max:1985, label:'Aretha Franklin',     artist_lock:'Aretha Franklin' },
  { query: 'Marvin Gaye karaoke',             genre:'soul',        era:'60s70s',  decade_min:1960, decade_max:1984, label:'Marvin Gaye',         artist_lock:'Marvin Gaye'     },
  { query: 'Stevie Wonder karaoke',           genre:'soul',        era:'60s70s',  decade_min:1963, decade_max:1985, label:'Stevie Wonder',       artist_lock:'Stevie Wonder'   },
  { query: 'James Brown karaoke instrumental',genre:'soul',        era:'60s70s',  decade_min:1960, decade_max:1985, label:'James Brown',         artist_lock:'James Brown'     },
  { query: 'Otis Redding karaoke',            genre:'soul',        era:'60s70s',  decade_min:1962, decade_max:1968, label:'Otis Redding',        artist_lock:'Otis Redding'    },

  // ════════════════════════════════════════════════════════════════════════════
  // COUNTRY
  // ════════════════════════════════════════════════════════════════════════════
  // Shania Twain — multiple queries to maximise song pool
  { query: 'Shania Twain karaoke instrumental',      genre:'country', era:'80s90s', decade_min:1993, decade_max:2003, label:'Shania Twain 1', artist_lock:'Shania Twain' },
  { query: 'Shania Twain karaoke',                   genre:'country', era:'80s90s', decade_min:1993, decade_max:2003, label:'Shania Twain 2', artist_lock:'Shania Twain' },
  { query: 'Shania Twain backing track',             genre:'country', era:'80s90s', decade_min:1993, decade_max:2003, label:'Shania Twain 3', artist_lock:'Shania Twain' },
  { query: '"Shania Twain" instrumental',            genre:'country', era:'80s90s', decade_min:1993, decade_max:2003, label:'Shania Twain 4', artist_lock:'Shania Twain' },

  // Dolly Parton — multiple queries
  { query: 'Dolly Parton karaoke instrumental',      genre:'country', era:'60s70s', decade_min:1967, decade_max:1990, label:'Dolly Parton 1', artist_lock:'Dolly Parton' },
  { query: 'Dolly Parton karaoke',                   genre:'country', era:'60s70s', decade_min:1967, decade_max:1990, label:'Dolly Parton 2', artist_lock:'Dolly Parton' },
  { query: 'Dolly Parton backing track',             genre:'country', era:'60s70s', decade_min:1967, decade_max:1990, label:'Dolly Parton 3', artist_lock:'Dolly Parton' },

  // Johnny Cash
  { query: 'Johnny Cash karaoke instrumental',       genre:'country', era:'60s70s', decade_min:1955, decade_max:1985, label:'Johnny Cash 1',  artist_lock:'Johnny Cash' },
  { query: 'Johnny Cash karaoke',                    genre:'country', era:'60s70s', decade_min:1955, decade_max:1985, label:'Johnny Cash 2',  artist_lock:'Johnny Cash' },
  { query: 'Johnny Cash backing track',              genre:'country', era:'60s70s', decade_min:1955, decade_max:1985, label:'Johnny Cash 3',  artist_lock:'Johnny Cash' },

  // Garth Brooks
  { query: 'Garth Brooks karaoke instrumental',      genre:'country', era:'80s90s', decade_min:1989, decade_max:2001, label:'Garth Brooks 1', artist_lock:'Garth Brooks' },
  { query: 'Garth Brooks karaoke',                   genre:'country', era:'80s90s', decade_min:1989, decade_max:2001, label:'Garth Brooks 2', artist_lock:'Garth Brooks' },

  { query: 'Kenny Rogers karaoke',                   genre:'country', era:'60s70s', decade_min:1976, decade_max:1992, label:'Kenny Rogers 1', artist_lock:'Kenny Rogers' },
  { query: 'Kenny Rogers backing track instrumental',genre:'country', era:'60s70s', decade_min:1976, decade_max:1992, label:'Kenny Rogers 2', artist_lock:'Kenny Rogers' },

  { query: 'Luke Bryan karaoke instrumental',        genre:'country', era:'modern',  decade_min:2007, decade_max:2029, label:'Luke Bryan 1',   artist_lock:'Luke Bryan' },
  { query: 'Luke Bryan karaoke',                     genre:'country', era:'modern',  decade_min:2007, decade_max:2029, label:'Luke Bryan 2',   artist_lock:'Luke Bryan' },

  { query: 'Morgan Wallen karaoke',                  genre:'country', era:'modern',  decade_min:2018, decade_max:2029, label:'Morgan Wallen 1',artist_lock:'Morgan Wallen' },
  { query: 'Morgan Wallen instrumental',             genre:'country', era:'modern',  decade_min:2018, decade_max:2029, label:'Morgan Wallen 2',artist_lock:'Morgan Wallen' },

  { query: 'Karaoke Hits country 80s 90s',           genre:'country', era:'80s90s',  decade_min:1980, decade_max:1999, label:'Country 80s-90s' },
  { query: 'Karaoke Hits country 2000s',             genre:'country', era:'2000s',   decade_min:2000, decade_max:2009, label:'Country 2000s'   },

  // ════════════════════════════════════════════════════════════════════════════
  // DANCE / ELECTRONIC
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Daft Punk karaoke instrumental',  genre:'dance',       era:'2000s',   decade_min:1997, decade_max:2013, label:'Daft Punk',           artist_lock:'Daft Punk'       },
  { query: 'Calvin Harris karaoke',           genre:'dance',       era:'modern',  decade_min:2007, decade_max:2029, label:'Calvin Harris',       artist_lock:'Calvin Harris'   },
  { query: 'David Guetta karaoke',            genre:'dance',       era:'modern',  decade_min:2009, decade_max:2029, label:'David Guetta',        artist_lock:'David Guetta'    },
  { query: 'Avicii karaoke instrumental',     genre:'dance',       era:'modern',  decade_min:2011, decade_max:2018, label:'Avicii',              artist_lock:'Avicii'          },
  { query: 'Karaoke dance hits 2000s',        genre:'dance',       era:'2000s',   decade_min:2000, decade_max:2009, label:'Dance 2000s'                                         },
  { query: 'Karaoke dance hits 2010s',        genre:'dance',       era:'modern',  decade_min:2010, decade_max:2019, label:'Dance 2010s'                                         },

  // ════════════════════════════════════════════════════════════════════════════
  // MOVIE SOUNDTRACKS
  // ════════════════════════════════════════════════════════════════════════════
  { query: 'Grease karaoke instrumental',     genre:'soundtracks', era:'60s70s',  decade_min:1978, decade_max:1979, label:'Grease'                                             },
  { query: 'Dirty Dancing karaoke instrumental',genre:'soundtracks',era:'80s90s', decade_min:1987, decade_max:1988, label:'Dirty Dancing'                                      },
  { query: 'Footloose karaoke instrumental',  genre:'soundtracks', era:'80s90s',  decade_min:1984, decade_max:1985, label:'Footloose'                                          },
  { query: 'Mamma Mia movie karaoke',         genre:'soundtracks', era:'modern',  decade_min:2008, decade_max:2019, label:'Mamma Mia'                                          },
  { query: 'Greatest Showman karaoke',        genre:'soundtracks', era:'modern',  decade_min:2017, decade_max:2018, label:'Greatest Showman'                                   },
  { query: 'La La Land karaoke instrumental', genre:'soundtracks', era:'modern',  decade_min:2016, decade_max:2017, label:'La La Land'                                        },
  { query: 'Encanto karaoke instrumental',    genre:'soundtracks', era:'modern',  decade_min:2021, decade_max:2022, label:'Encanto'                                            },
  { query: 'Moana karaoke instrumental',      genre:'soundtracks', era:'modern',  decade_min:2016, decade_max:2017, label:'Moana'                                              },
  { query: 'Frozen karaoke instrumental',     genre:'soundtracks', era:'modern',  decade_min:2013, decade_max:2020, label:'Frozen'                                             },
  { query: 'Guardians Galaxy karaoke',        genre:'soundtracks', era:'modern',  decade_min:2014, decade_max:2019, label:'Guardians of Galaxy'                                },
  { query: 'Disney karaoke instrumental',     genre:'soundtracks', era:'modern',  decade_min:1989, decade_max:2029, label:'Disney Mix'                                         },
];

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function deezerFetch(url) {
  await new Promise(r => setTimeout(r, 200)); // ~5 req/s — conservative
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Deezer HTTP ' + res.status);
  return res.json();
}

async function fetchInstrumentalTracks(query) {
  const url  = 'https://api.deezer.com/search?q=' + encodeURIComponent(query) + '&limit=100';
  const data = await deezerFetch(url);
  return (data.data || []).filter(t =>
    t.preview &&
    isInstrumental(t) &&
    hasSensibleDuration(t) &&
    !isRejectedTitle(t.title || '')
  );
}

// ─── Insert with strict validation ───────────────────────────────────────────
async function insertTracks(tracks, source) {
  if (!tracks.length) return { inserted: 0, rejected: 0 };
  let inserted = 0;
  let rejected = 0;

  for (const track of tracks) {
    // ── 1. Extract real title ──────────────────────────────────────────────
    const title = extractRealTitle(track);
    if (!title || title.length < 2) { rejected++; continue; }

    const lowerTitle = title.toLowerCase().trim();
    if (['karaoke version','instrumental','backing track','karaoke',
         'karaoke version of the original','instrumental version'].includes(lowerTitle)) {
      rejected++; continue;
    }
    if (isRejectedTitle(title)) { rejected++; continue; }

    // ── 2. Extract REAL artist — REJECT if we can't find one ──────────────
    const realArtist = extractOriginalArtist(track);
    if (!realArtist) {
      // No artist attribution found in title — we cannot trust this entry
      rejected++;
      continue;
    }

    // ── 3. artist_lock — strict enforcement ──────────────────────────────────
    if (source.artist_lock) {
      const lockNorm   = normArtist(source.artist_lock);
      const artistNorm = normArtist(realArtist);

      // Strategy: the extracted artist must START WITH or exactly equal the
      // locked artist name. We allow "Shania Twain & Friends" to match
      // "Shania Twain", but NOT "Coldplay" to match "Shania Twain".
      // We do NOT allow lockNorm.includes(artistNorm) because that would
      // let "Taylor" match "Taylor Swift".
      const exactMatch  = artistNorm === lockNorm;
      const startsMatch = artistNorm.startsWith(lockNorm + ' ') ||
                          artistNorm.startsWith(lockNorm + '&') ||
                          artistNorm.startsWith(lockNorm + ',');

      if (!exactMatch && !startsMatch) {
        rejected++;
        continue;
      }
    }

    // ── 4. Year / decade strict window ────────────────────────────────────
    const year = releaseYear(track);
    if (year !== null) {
      if (year < source.decade_min || year > source.decade_max) {
        // Track release year is outside the allowed window — reject
        rejected++;
        continue;
      }
    }
    // If year is unknown (null), we still allow it — better some uncertainty
    // than rejecting everything without a date. Era is set from source.

    const era    = source.era;
    const genre  = source.genre;
    const decade = year;
    const cleanArtist = realArtist.split(/[,&]/)[0].trim();
    const deezerQuery = '"' + title + '" "' + cleanArtist + '" instrumental karaoke';

    try {
      const result = await pool.query(
        'INSERT INTO songs (title, artist, era, genre, decade, deezer_query) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) ' +
        'ON CONFLICT (lower(title), lower(artist)) DO NOTHING',
        [title, realArtist, era, genre, decade, deezerQuery]
      );
      if (result.rowCount > 0) inserted++;
    } catch (err) {
      console.warn('  Insert error [' + title + ']:', err.message);
    }
  }
  return { inserted, rejected };
}

// ─── Schema ───────────────────────────────────────────────────────────────────
async function ensureSchema() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS songs (' +
    '  id           SERIAL PRIMARY KEY,' +
    '  title        TEXT        NOT NULL,' +
    '  artist       TEXT        NOT NULL,' +
    '  era          TEXT        NOT NULL DEFAULT \'modern\',' +
    '  genre        TEXT,' +
    '  decade       SMALLINT,' +
    '  deezer_query TEXT        NOT NULL,' +
    '  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,' +
    '  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()' +
    ')'
  );
  // Add genre column to existing DBs
  await pool.query('ALTER TABLE songs ADD COLUMN IF NOT EXISTS genre TEXT').catch(() => {});
  // Drop stale preview cache columns — Deezer tokens expire in ~30 min
  await pool.query('ALTER TABLE songs DROP COLUMN IF EXISTS preview_cache').catch(() => {});
  await pool.query('ALTER TABLE songs DROP COLUMN IF EXISTS preview_cached_at').catch(() => {});

  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_title_artist_unique ' +
    'ON songs (lower(title), lower(artist))'
  );
  await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_era_enabled ON songs (era, enabled)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_genre_enabled ON songs (genre, enabled)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_enabled ON songs (enabled)');
}

// ─── Main ingest ──────────────────────────────────────────────────────────────
async function ingestFromDeezer(options) {
  const force = options && options.force;
  await ensureSchema();

  const countRes = await pool.query('SELECT COUNT(*) AS n FROM songs WHERE enabled = true');
  const existing = parseInt(countRes.rows[0].n);

  if (!force && existing >= 100) {
    console.log('Catalog has ' + existing + ' songs — skipping ingest');
    return { skipped: true, existing };
  }

  console.log('Starting strict instrumental ingest (' + existing + ' in DB)...');
  const started = Date.now();
  let totalInserted = 0;
  let totalRejected = 0;
  let errors = 0;

  for (const source of SOURCES) {
    try {
      const tracks  = await fetchInstrumentalTracks(source.query);
      const { inserted, rejected } = await insertTracks(tracks, source);
      totalInserted += inserted;
      totalRejected += rejected;
      if (tracks.length > 0) {
        console.log(
          '  [' + source.genre + '] ' + source.label +
          ': ' + tracks.length + ' fetched, ' + inserted + ' inserted, ' + rejected + ' rejected'
        );
      }
    } catch (err) {
      errors++;
      console.warn('  FAIL ' + source.label + ': ' + err.message);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const finalRes = await pool.query('SELECT COUNT(*) AS n FROM songs WHERE enabled = true');
  console.log(
    'Ingest done in ' + elapsed + 's — ' + finalRes.rows[0].n + ' songs total' +
    ' (' + totalRejected + ' rejected by strict filter)'
  );
  return { totalInserted, totalRejected, total: parseInt(finalRes.rows[0].n), elapsed, errors };
}

module.exports = { ingestFromDeezer, ensureSchema };
