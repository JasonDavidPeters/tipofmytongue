/**
 * catalog.js — Deezer ingestion engine v3
 *
 * Changes from v2:
 *  - Added `genre` column (e.g. "pop", "rock", "hip-hop", "90s-rap", "soundtracks")
 *  - Mashup/compilation/medley rejection at ingestion time
 *  - preview_cache column REMOVED from insert — we never store preview URLs
 *    because Deezer CDN tokens expire in ~30 minutes
 *  - Tighter search sources organised by genre + era
 *  - Duration filter: reject tracks under 60s (intros/snippets) or over 600s (albums)
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
// These title patterns indicate medleys, megamixes, or multi-song compilations
// where players cannot reliably identify a single song.
const REJECT_TITLE_PATTERNS = [
  /\bmedley\b/i,
  /\bmegamix\b/i,
  /\bmashup\b/i,
  /\bmash.?up\b/i,
  /\bremix\s+medley\b/i,
  /\bcollection\b/i,
  /\bcompilation\b/i,
  /\bgreatest hits\b/i,  // avoid generic "greatest hits" tracks
  /\bbest of\b/i,
  /\btribute to (various|multiple|many)\b/i,
  /\d+\s+(hits|songs|classics)\s+in\s+\d+/i,  // "20 hits in 10 minutes"
  /hits?\s+of\s+the\s+\d{4}s?\b/i,            // "Hits of the 80s" compilation tracks
  /\bnon.?stop\b/i,                            // "Non-Stop Party Mix"
  /\bparty\s+mix\b/i,
  /\bkaraoke\s+megamix\b/i,
];

function isRejectedTitle(title) {
  return REJECT_TITLE_PATTERNS.some(p => p.test(title));
}

// ─── Duration filter ──────────────────────────────────────────────────────────
// Deezer previews are 30 seconds regardless, but the full track duration
// signals whether this is a real song (60s-600s) or a snippet/album run-on.
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
const ARTIST_PATTERNS = [
  /originally performed by\s+([^)([\]\n,]+)/i,
  /originally recorded by\s+([^)([\]\n,]+)/i,
  /originally popularized by\s+([^)([\]\n,]+)/i,
  /originally by\s+([^)([\]\n,]+)/i,
  /made famous by\s+([^)([\]\n,]+)/i,
  /as made famous by\s+([^)([\]\n,]+)/i,
  /as performed by\s+([^)([\]\n,]+)/i,
  /in the style of\s+([^)([\]\n,]+)/i,
  /tribute to\s+([^)([\]\n,]+)/i,
  /\[([^\]]+?)\s+karaoke]/i,
  /\(([^)]+?)\s+karaoke\)/i,
];
function extractOriginalArtist(track) {
  const title = track.title || '';
  for (const pattern of ARTIST_PATTERNS) {
    const m = title.match(pattern);
    if (m) {
      const artist = m[1]
        .replace(/\s*[-\u2013]\s*(karaoke|instrumental|version|track).*/i, '')
        .replace(/\s*\(.*\)$/, '')
        .trim();
      if (artist.length > 1) return artist;
    }
  }
  return null;
}

// ─── Era classifier ───────────────────────────────────────────────────────────
function inferEra(track, defaultEra) {
  const year = track.album && track.album.release_date
    ? parseInt(track.album.release_date.slice(0, 4)) : null;
  if (!year) return defaultEra;
  if (year < 1980) return '60s70s';
  if (year < 2000) return '80s90s';
  if (year < 2010) return '2000s';
  return 'modern';
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function deezerFetch(url) {
  await new Promise(r => setTimeout(r, 150));
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

// ─── Insert ───────────────────────────────────────────────────────────────────
// Note: we do NOT store preview_cache — URLs expire too fast to be useful.
async function insertInstrumentalTracks(tracks, defaultEra, genre) {
  if (!tracks.length) return 0;
  let count = 0;

  for (const track of tracks) {
    const title          = extractRealTitle(track);
    const originalArtist = extractOriginalArtist(track) || (track.artist && track.artist.name);

    if (!title || title.length < 2 || !originalArtist) continue;

    // Reject bare version labels
    const lowerTitle = title.toLowerCase().trim();
    if (['karaoke version', 'instrumental', 'backing track', 'karaoke',
         'karaoke version of the original', 'instrumental version'].includes(lowerTitle)) continue;

    // Second pass rejection on the cleaned title
    if (isRejectedTitle(title)) continue;

    const era      = inferEra(track, defaultEra);
    const decade   = track.album && track.album.release_date
      ? parseInt(track.album.release_date.slice(0, 4)) : null;
    const cleanArtist = originalArtist.split(/[,&]/)[0].trim();
    const deezerQuery = '"' + title + '" "' + cleanArtist + '" instrumental karaoke';

    try {
      const result = await pool.query(
        'INSERT INTO songs (title, artist, era, genre, decade, deezer_query) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) ' +
        'ON CONFLICT (lower(title), lower(artist)) DO NOTHING',
        [title, originalArtist, era, genre || null, decade, deezerQuery]
      );
      if (result.rowCount > 0) count++;
    } catch (err) {
      console.warn('Insert skipped [' + title + ']:', err.message);
    }
  }
  return count;
}

// ─── Search sources — organised by genre ─────────────────────────────────────
// genre field maps to the DB genre column and the frontend filter dropdown.
// Supported genres so far (easily extended):
//   pop, rock, hip-hop, rnb, country, dance, alternative,
//   90s-rap, 2000s-pop, soundtracks, classic-rock, soul
const SOURCES = [
  // ── POP ──────────────────────────────────────────────────────────────────────
  { query: 'Karaoke Hits pop modern',        era: 'modern',  genre: 'pop',          label: 'Pop Karaoke Modern'     },
  { query: 'Karaoke Hits pop 2000s',         era: '2000s',   genre: 'pop',          label: 'Pop Karaoke 2000s'      },
  { query: 'Karaoke Hits pop 90s',           era: '80s90s',  genre: 'pop',          label: 'Pop Karaoke 90s'        },
  { query: 'Karaoke Hits pop 80s',           era: '80s90s',  genre: 'pop',          label: 'Pop Karaoke 80s'        },
  { query: 'Taylor Swift karaoke',           era: 'modern',  genre: 'pop',          label: 'Taylor Swift'           },
  { query: 'Adele karaoke instrumental',     era: 'modern',  genre: 'pop',          label: 'Adele'                  },
  { query: 'Ed Sheeran karaoke',             era: 'modern',  genre: 'pop',          label: 'Ed Sheeran'             },
  { query: 'Bruno Mars karaoke',             era: 'modern',  genre: 'pop',          label: 'Bruno Mars'             },
  { query: 'Billie Eilish karaoke',          era: 'modern',  genre: 'pop',          label: 'Billie Eilish'          },
  { query: 'Olivia Rodrigo karaoke',         era: 'modern',  genre: 'pop',          label: 'Olivia Rodrigo'         },
  { query: 'Dua Lipa karaoke instrumental',  era: 'modern',  genre: 'pop',          label: 'Dua Lipa'               },
  { query: 'Harry Styles karaoke',           era: 'modern',  genre: 'pop',          label: 'Harry Styles'           },
  { query: 'Ariana Grande karaoke',          era: 'modern',  genre: 'pop',          label: 'Ariana Grande'          },
  { query: 'Justin Bieber karaoke',          era: 'modern',  genre: 'pop',          label: 'Justin Bieber'          },
  { query: 'Lady Gaga karaoke instrumental', era: '2000s',   genre: 'pop',          label: 'Lady Gaga'              },
  { query: 'Beyonce karaoke instrumental',   era: '2000s',   genre: 'pop',          label: 'Beyonce Pop'            },
  { query: 'Rihanna karaoke instrumental',   era: '2000s',   genre: 'pop',          label: 'Rihanna'                },
  { query: 'Britney Spears karaoke',         era: '2000s',   genre: 'pop',          label: 'Britney Spears'         },
  { query: 'Justin Timberlake karaoke',      era: '2000s',   genre: 'pop',          label: 'Justin Timberlake'      },
  { query: 'NSYNC karaoke instrumental',     era: '80s90s',  genre: 'pop',          label: 'NSYNC'                  },
  { query: 'Backstreet Boys karaoke',        era: '80s90s',  genre: 'pop',          label: 'Backstreet Boys'        },
  { query: 'Spice Girls karaoke',            era: '80s90s',  genre: 'pop',          label: 'Spice Girls'            },
  { query: 'ABBA karaoke instrumental',      era: '60s70s',  genre: 'pop',          label: 'ABBA'                   },
  { query: 'Elton John karaoke instrumental',era: '60s70s',  genre: 'pop',          label: 'Elton John'             },

  // ── ROCK ─────────────────────────────────────────────────────────────────────
  { query: 'Karaoke Hits rock classic',      era: '60s70s',  genre: 'rock',         label: 'Classic Rock Karaoke'   },
  { query: 'Karaoke Hits rock 80s',          era: '80s90s',  genre: 'rock',         label: 'Rock Karaoke 80s'       },
  { query: 'Karaoke Hits rock 90s',          era: '80s90s',  genre: 'rock',         label: 'Rock Karaoke 90s'       },
  { query: 'Queen karaoke instrumental',     era: '60s70s',  genre: 'rock',         label: 'Queen'                  },
  { query: 'Beatles karaoke instrumental',   era: '60s70s',  genre: 'rock',         label: 'Beatles'                },
  { query: 'Led Zeppelin karaoke instrumental',era:'60s70s', genre: 'rock',         label: 'Led Zeppelin'           },
  { query: 'Rolling Stones karaoke',         era: '60s70s',  genre: 'rock',         label: 'Rolling Stones'         },
  { query: 'Fleetwood Mac karaoke',          era: '60s70s',  genre: 'rock',         label: 'Fleetwood Mac'          },
  { query: 'Eagles karaoke instrumental',    era: '60s70s',  genre: 'rock',         label: 'Eagles'                 },
  { query: 'David Bowie karaoke instrumental',era:'60s70s',  genre: 'rock',         label: 'David Bowie'            },
  { query: 'Guns N Roses karaoke',           era: '80s90s',  genre: 'rock',         label: 'Guns N Roses'           },
  { query: 'Bon Jovi karaoke instrumental',  era: '80s90s',  genre: 'rock',         label: 'Bon Jovi'               },
  { query: 'U2 karaoke instrumental',        era: '80s90s',  genre: 'rock',         label: 'U2'                     },
  { query: 'Nirvana karaoke instrumental',   era: '80s90s',  genre: 'rock',         label: 'Nirvana'                },
  { query: 'Pearl Jam karaoke instrumental', era: '80s90s',  genre: 'rock',         label: 'Pearl Jam'              },
  { query: 'Oasis karaoke instrumental',     era: '80s90s',  genre: 'rock',         label: 'Oasis'                  },
  { query: 'Green Day karaoke instrumental', era: '2000s',   genre: 'rock',         label: 'Green Day'              },
  { query: 'Coldplay karaoke instrumental',  era: '2000s',   genre: 'rock',         label: 'Coldplay'               },
  { query: 'Foo Fighters karaoke',           era: '2000s',   genre: 'rock',         label: 'Foo Fighters'           },

  // ── HIP-HOP / RAP ────────────────────────────────────────────────────────────
  { query: 'Eminem karaoke instrumental',    era: '2000s',   genre: 'hip-hop',      label: 'Eminem'                 },
  { query: 'Drake karaoke instrumental',     era: 'modern',  genre: 'hip-hop',      label: 'Drake'                  },
  { query: 'Kanye West karaoke instrumental',era: '2000s',   genre: 'hip-hop',      label: 'Kanye West'             },
  { query: 'Jay Z karaoke instrumental',     era: '2000s',   genre: 'hip-hop',      label: 'Jay-Z'                  },
  { query: 'Kendrick Lamar karaoke',         era: 'modern',  genre: 'hip-hop',      label: 'Kendrick Lamar'         },
  { query: 'Post Malone karaoke',            era: 'modern',  genre: 'hip-hop',      label: 'Post Malone'            },
  { query: 'Travis Scott karaoke',           era: 'modern',  genre: 'hip-hop',      label: 'Travis Scott'           },
  { query: 'Lil Nas X karaoke',              era: 'modern',  genre: 'hip-hop',      label: 'Lil Nas X'              },

  // ── 90s RAP (its own genre for the dropdown) ──────────────────────────────────
  { query: 'Tupac karaoke instrumental',     era: '80s90s',  genre: '90s-rap',      label: 'Tupac'                  },
  { query: 'Biggie karaoke instrumental',    era: '80s90s',  genre: '90s-rap',      label: 'Biggie'                 },
  { query: 'Snoop Dogg karaoke 90s',         era: '80s90s',  genre: '90s-rap',      label: 'Snoop Dogg 90s'         },
  { query: 'Dr Dre karaoke instrumental',    era: '80s90s',  genre: '90s-rap',      label: 'Dr Dre'                 },
  { query: 'Warren G karaoke instrumental',  era: '80s90s',  genre: '90s-rap',      label: 'Warren G'               },
  { query: 'Nas karaoke instrumental',       era: '80s90s',  genre: '90s-rap',      label: 'Nas'                    },
  { query: 'DMX karaoke instrumental',       era: '80s90s',  genre: '90s-rap',      label: 'DMX'                    },
  { query: 'Wu-Tang Clan karaoke',           era: '80s90s',  genre: '90s-rap',      label: 'Wu-Tang Clan'           },
  { query: 'Coolio karaoke instrumental',    era: '80s90s',  genre: '90s-rap',      label: 'Coolio'                 },
  { query: 'Missy Elliott karaoke',          era: '80s90s',  genre: '90s-rap',      label: 'Missy Elliott'          },
  { query: 'TLC karaoke instrumental',       era: '80s90s',  genre: '90s-rap',      label: 'TLC'                    },

  // ── R&B / SOUL ───────────────────────────────────────────────────────────────
  { query: 'Aretha Franklin karaoke',        era: '60s70s',  genre: 'rnb',          label: 'Aretha Franklin'        },
  { query: 'Marvin Gaye karaoke',            era: '60s70s',  genre: 'rnb',          label: 'Marvin Gaye'            },
  { query: 'Stevie Wonder karaoke',          era: '60s70s',  genre: 'rnb',          label: 'Stevie Wonder'          },
  { query: 'Whitney Houston karaoke',        era: '80s90s',  genre: 'rnb',          label: 'Whitney Houston'        },
  { query: 'Mariah Carey karaoke',           era: '80s90s',  genre: 'rnb',          label: 'Mariah Carey'           },
  { query: 'Usher karaoke instrumental',     era: '2000s',   genre: 'rnb',          label: 'Usher'                  },
  { query: 'Alicia Keys karaoke',            era: '2000s',   genre: 'rnb',          label: 'Alicia Keys'            },
  { query: 'Amy Winehouse karaoke',          era: '2000s',   genre: 'rnb',          label: 'Amy Winehouse'          },
  { query: 'Sam Smith karaoke instrumental', era: 'modern',  genre: 'rnb',          label: 'Sam Smith'              },
  { query: 'The Weeknd karaoke',             era: 'modern',  genre: 'rnb',          label: 'The Weeknd'             },
  { query: 'Frank Ocean karaoke',            era: 'modern',  genre: 'rnb',          label: 'Frank Ocean'            },
  { query: 'SZA karaoke instrumental',       era: 'modern',  genre: 'rnb',          label: 'SZA'                    },

  // ── COUNTRY ──────────────────────────────────────────────────────────────────
  { query: 'Karaoke Hits country classic',   era: '60s70s',  genre: 'country',      label: 'Classic Country Karaoke'},
  { query: 'Karaoke Hits country 90s',       era: '80s90s',  genre: 'country',      label: 'Country Karaoke 90s'    },
  { query: 'Karaoke Hits country modern',    era: 'modern',  genre: 'country',      label: 'Country Karaoke Modern' },
  { query: 'Dolly Parton karaoke',           era: '60s70s',  genre: 'country',      label: 'Dolly Parton'           },
  { query: 'Johnny Cash karaoke',            era: '60s70s',  genre: 'country',      label: 'Johnny Cash'            },
  { query: 'Garth Brooks karaoke',           era: '80s90s',  genre: 'country',      label: 'Garth Brooks'           },
  { query: 'Shania Twain karaoke',           era: '80s90s',  genre: 'country',      label: 'Shania Twain'           },
  { query: 'Luke Bryan karaoke instrumental',era: 'modern',  genre: 'country',      label: 'Luke Bryan'             },
  { query: 'Morgan Wallen karaoke',          era: 'modern',  genre: 'country',      label: 'Morgan Wallen'          },

  // ── DANCE / ELECTRONIC ───────────────────────────────────────────────────────
  { query: 'Karaoke dance hits modern',      era: 'modern',  genre: 'dance',        label: 'Dance Karaoke Modern'   },
  { query: 'Karaoke dance hits 2000s',       era: '2000s',   genre: 'dance',        label: 'Dance Karaoke 2000s'    },
  { query: 'Daft Punk karaoke instrumental', era: '2000s',   genre: 'dance',        label: 'Daft Punk'              },
  { query: 'Calvin Harris karaoke',          era: 'modern',  genre: 'dance',        label: 'Calvin Harris'          },
  { query: 'David Guetta karaoke',           era: 'modern',  genre: 'dance',        label: 'David Guetta'           },
  { query: 'Avicii karaoke instrumental',    era: 'modern',  genre: 'dance',        label: 'Avicii'                 },

  // ── SOUNDTRACKS / MOVIE ──────────────────────────────────────────────────────
  { query: 'movie soundtrack karaoke instrumental', era: 'modern', genre: 'soundtracks', label: 'Movie Soundtracks' },
  { query: 'Disney karaoke instrumental',           era: 'modern', genre: 'soundtracks', label: 'Disney'            },
  { query: 'Grease karaoke instrumental',           era: '60s70s', genre: 'soundtracks', label: 'Grease'            },
  { query: 'Dirty Dancing karaoke',                 era: '80s90s', genre: 'soundtracks', label: 'Dirty Dancing'     },
  { query: 'Footloose karaoke instrumental',        era: '80s90s', genre: 'soundtracks', label: 'Footloose'         },
  { query: 'Mamma Mia karaoke instrumental',        era: 'modern', genre: 'soundtracks', label: 'Mamma Mia'         },
  { query: 'Bohemian Rhapsody movie karaoke',       era: 'modern', genre: 'soundtracks', label: 'Bohemian Rhapsody Movie'},
  { query: 'Guardians Galaxy karaoke',              era: 'modern', genre: 'soundtracks', label: 'Guardians of Galaxy'},
  { query: 'La La Land karaoke instrumental',       era: 'modern', genre: 'soundtracks', label: 'La La Land'        },
  { query: 'Greatest Showman karaoke',              era: 'modern', genre: 'soundtracks', label: 'Greatest Showman'  },
  { query: 'Encanto karaoke instrumental',          era: 'modern', genre: 'soundtracks', label: 'Encanto'           },
  { query: 'Moana karaoke instrumental',            era: 'modern', genre: 'soundtracks', label: 'Moana'             },

  // ── CLASSIC ROCK (60s-70s specific) ──────────────────────────────────────────
  { query: 'classic rock 60s karaoke instrumental', era: '60s70s', genre: 'classic-rock', label: '60s Rock Sweep'   },
  { query: 'classic rock 70s karaoke instrumental', era: '60s70s', genre: 'classic-rock', label: '70s Rock Sweep'   },
  { query: 'Pink Floyd karaoke instrumental',       era: '60s70s', genre: 'classic-rock', label: 'Pink Floyd'       },
  { query: 'Jimi Hendrix karaoke instrumental',     era: '60s70s', genre: 'classic-rock', label: 'Jimi Hendrix'     },
  { query: 'The Doors karaoke instrumental',        era: '60s70s', genre: 'classic-rock', label: 'The Doors'        },
  { query: 'Creedence Clearwater karaoke',          era: '60s70s', genre: 'classic-rock', label: 'CCR'              },
  { query: 'Aerosmith karaoke instrumental',        era: '60s70s', genre: 'classic-rock', label: 'Aerosmith'        },
  { query: 'AC/DC karaoke instrumental',            era: '60s70s', genre: 'classic-rock', label: 'AC/DC'            },
  { query: 'Van Halen karaoke instrumental',        era: '80s90s', genre: 'classic-rock', label: 'Van Halen'        },
  { query: 'Bruce Springsteen karaoke',             era: '60s70s', genre: 'classic-rock', label: 'Bruce Springsteen'},

  // ── SOUL / MOTOWN ─────────────────────────────────────────────────────────────
  { query: 'Motown karaoke instrumental 60s',       era: '60s70s', genre: 'soul',    label: 'Motown 60s'            },
  { query: 'Motown karaoke instrumental 70s',       era: '60s70s', genre: 'soul',    label: 'Motown 70s'            },
  { query: 'James Brown karaoke instrumental',      era: '60s70s', genre: 'soul',    label: 'James Brown'           },
  { query: 'Otis Redding karaoke',                  era: '60s70s', genre: 'soul',    label: 'Otis Redding'          },
  { query: 'Sam Cooke karaoke instrumental',        era: '60s70s', genre: 'soul',    label: 'Sam Cooke'             },
];

// ─── Schema ───────────────────────────────────────────────────────────────────
async function ensureSchema() {
  // Create table — genre column included from the start
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

  // Add genre column if upgrading from an older schema
  await pool.query(
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS genre TEXT'
  ).catch(() => {});

  // Remove preview_cache columns if they exist from an older schema
  // (they cause 403s — Deezer tokens expire in ~30 min)
  await pool.query(
    'ALTER TABLE songs DROP COLUMN IF EXISTS preview_cache'
  ).catch(() => {});
  await pool.query(
    'ALTER TABLE songs DROP COLUMN IF EXISTS preview_cached_at'
  ).catch(() => {});

  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_title_artist_unique ' +
    'ON songs (lower(title), lower(artist))'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_songs_era_enabled ON songs (era, enabled)'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_songs_genre_enabled ON songs (genre, enabled)'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_songs_enabled ON songs (enabled)'
  );
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

  console.log('Starting instrumental-only ingest (' + existing + ' in DB)...');

  const started = Date.now();
  let totalInserted = 0;
  let errors = 0;

  for (const source of SOURCES) {
    try {
      const tracks   = await fetchInstrumentalTracks(source.query);
      const inserted = await insertInstrumentalTracks(tracks, source.era, source.genre);
      totalInserted += inserted;
      if (tracks.length > 0) {
        console.log('  OK [' + source.genre + '] ' + source.label + ': ' + tracks.length + ' found, ' + inserted + ' new');
      }
    } catch (err) {
      errors++;
      console.warn('  FAIL ' + source.label + ': ' + err.message);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const finalRes = await pool.query('SELECT COUNT(*) AS n FROM songs WHERE enabled = true');
  console.log('Ingest done in ' + elapsed + 's — ' + finalRes.rows[0].n + ' total songs');
  return { totalInserted, total: parseInt(finalRes.rows[0].n), elapsed, errors };
}

module.exports = { ingestFromDeezer, ensureSchema };
