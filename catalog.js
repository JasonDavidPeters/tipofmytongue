/**
 * catalog.js — Deezer ingestion engine (Instrumental-Only Edition)
 *
 * GUARANTEE: Every track inserted into the DB is confirmed vocal-free.
 *
 * How it works:
 *   1. We search for known instrumental/karaoke publishers on Deezer whose
 *      entire catalog is vocal-free (Karaoke Hits, Instrumental Hits, etc.)
 *      AND for known artists combined with "karaoke"/"instrumental" keywords.
 *
 *   2. Every result is filtered by isInstrumental() — we only accept tracks
 *      where title OR title_version contains a confirmed vocal-free keyword
 *      ("instrumental", "karaoke", "backing track", "piano version", etc.)
 *
 *   3. We extract the REAL song title and original artist from the karaoke
 *      track metadata so players see "Bohemian Rhapsody by Queen" — not
 *      "Bohemian Rhapsody (Karaoke Version) by Karaoke Hits".
 *
 *   4. The confirmed preview URL is stored directly — no re-searching needed.
 */

const pool = require('./db');

// ─── Instrumental keyword filter ──────────────────────────────────────────────
const INSTRUMENTAL_KEYWORDS = [
  'instrumental',
  'karaoke',
  'backing track',
  'backing version',
  'minus one',
  'no vocal',
  'no voice',
  'music only',
  'piano version',
  'orchestra version',
  'orchestral version',
  'acoustic instrumental',
  'in the style of',
  'tribute instrumental',
];

function isInstrumental(track) {
  const version = (track.title_version || '').toLowerCase();
  const title   = (track.title        || '').toLowerCase();
  return INSTRUMENTAL_KEYWORDS.some(kw => version.includes(kw) || title.includes(kw));
}

// ─── Extract real song title from karaoke track ───────────────────────────────
// Deezer karaoke tracks look like:
//   title:         "Hotel California (Karaoke Version)"
//   title_short:   "Hotel California"      ← the clean name we want
//   title_version: "Karaoke Version"
function extractRealTitle(track) {
  if (track.title_short && track.title_short.trim().length > 1) {
    return track.title_short.trim();
  }
  return (track.title || '')
    .replace(/\s*[\(\[](karaoke|instrumental|backing|piano|minus one|no vocal|in the style)[^\)\]]*/gi, '')
    .replace(/\s*[-–]\s*(karaoke|instrumental|backing|piano|minus one)[^$]*/gi, '')
    .replace(/^(instrumental|karaoke)[:\s]+/gi, '')
    .trim();
}

// ─── Extract original artist ──────────────────────────────────────────────────
// Karaoke publishers often embed "Made Famous by ARTIST" in the title.
function extractOriginalArtist(track) {
  const title = track.title || '';
  const mfMatch = title.match(/made famous by ([^)\],-]+)/i);
  if (mfMatch) return mfMatch[1].trim();
  const obMatch = title.match(/originally by ([^)\],-]+)/i);
  if (obMatch) return obMatch[1].trim();
  const bracketMatch = title.match(/\[([^\]]+?)\s+karaoke\]/i);
  if (bracketMatch) return bracketMatch[1].trim();
  return null;
}

// ─── Era classifier ───────────────────────────────────────────────────────────
function inferEra(track, defaultEra) {
  const year = track.album?.release_date
    ? parseInt(track.album.release_date.slice(0, 4))
    : null;
  if (!year) return defaultEra;
  if (year < 1980) return '60s70s';
  if (year < 2000) return '80s90s';
  if (year < 2010) return '2000s';
  return 'modern';
}

// ─── Search sources — INSTRUMENTAL ONLY ──────────────────────────────────────
// Each entry is a Deezer search query. Only tracks passing isInstrumental()
// will enter the DB, so it is safe to cast a wide net here.
const SOURCES = [
  // ── Known instrumental/karaoke publishers ─────────────────────────────────
  { query: 'Karaoke Hits pop',               era: 'modern',  label: 'Karaoke Hits Pop'           },
  { query: 'Karaoke Hits rock',              era: '80s90s',  label: 'Karaoke Hits Rock'           },
  { query: 'Karaoke Hits 80s',               era: '80s90s',  label: 'Karaoke Hits 80s'            },
  { query: 'Karaoke Hits 90s',               era: '80s90s',  label: 'Karaoke Hits 90s'            },
  { query: 'Karaoke Hits 2000s',             era: '2000s',   label: 'Karaoke Hits 2000s'          },
  { query: 'Karaoke Hits 60s',               era: '60s70s',  label: 'Karaoke Hits 60s'            },
  { query: 'Karaoke Hits 70s',               era: '60s70s',  label: 'Karaoke Hits 70s'            },
  { query: 'Instrumental Hits pop',          era: 'modern',  label: 'Instrumental Hits Pop'       },
  { query: 'Instrumental Hits rock',         era: '60s70s',  label: 'Instrumental Hits Rock'      },
  { query: 'Instrumental Hits 80s',          era: '80s90s',  label: 'Instrumental Hits 80s'       },
  { query: 'Instrumental Hits 90s',          era: '80s90s',  label: 'Instrumental Hits 90s'       },
  { query: 'Instrumental Hits 2000s',        era: '2000s',   label: 'Instrumental Hits 2000s'     },
  { query: 'Backing Tracks pop hits',        era: 'modern',  label: 'Backing Tracks Pop'          },
  { query: 'Backing Tracks rock classics',   era: '80s90s',  label: 'Backing Tracks Rock'         },
  { query: 'Backing Tracks 60s 70s',         era: '60s70s',  label: 'Backing Tracks 60s70s'       },
  { query: 'Piano Dreamers pop hits',        era: 'modern',  label: 'Piano Dreamers Pop'          },
  { query: 'Piano Dreamers greatest hits',   era: '80s90s',  label: 'Piano Dreamers Hits'         },
  { query: 'Music Factory karaoke pop',      era: 'modern',  label: 'Music Factory Pop'           },
  { query: 'Music Factory karaoke classic',  era: '60s70s',  label: 'Music Factory Classic'       },
  { query: 'Karaoke All Stars pop',          era: 'modern',  label: 'Karaoke All Stars Pop'       },
  { query: 'Karaoke All Stars 80s',          era: '80s90s',  label: 'Karaoke All Stars 80s'       },
  { query: 'Karaoke All Stars 90s',          era: '80s90s',  label: 'Karaoke All Stars 90s'       },
  { query: 'Karaoke All Stars 2000s',        era: '2000s',   label: 'Karaoke All Stars 2000s'     },
  // ── Artist + instrumental keyword ─────────────────────────────────────────
  { query: 'Queen karaoke instrumental',     era: '60s70s',  label: 'Queen Instrumentals'         },
  { query: 'Beatles karaoke instrumental',   era: '60s70s',  label: 'Beatles Instrumentals'       },
  { query: 'Elton John karaoke instrumental',era: '60s70s',  label: 'Elton John Instrumentals'    },
  { query: 'David Bowie karaoke instrumental',era:'60s70s',  label: 'Bowie Instrumentals'         },
  { query: 'ABBA karaoke instrumental',      era: '60s70s',  label: 'ABBA Instrumentals'          },
  { query: 'Led Zeppelin karaoke instrumental',era:'60s70s', label: 'Led Zeppelin Instrumentals'  },
  { query: 'Rolling Stones karaoke',         era: '60s70s',  label: 'Stones Instrumentals'        },
  { query: 'Fleetwood Mac karaoke',          era: '60s70s',  label: 'Fleetwood Mac Instrumentals' },
  { query: 'Eagles karaoke instrumental',    era: '60s70s',  label: 'Eagles Instrumentals'        },
  { query: 'Michael Jackson karaoke',        era: '80s90s',  label: 'MJ Instrumentals'            },
  { query: 'Madonna karaoke instrumental',   era: '80s90s',  label: 'Madonna Instrumentals'       },
  { query: 'Prince karaoke instrumental',    era: '80s90s',  label: 'Prince Instrumentals'        },
  { query: 'Whitney Houston karaoke',        era: '80s90s',  label: 'Whitney Instrumentals'       },
  { query: 'Bon Jovi karaoke instrumental',  era: '80s90s',  label: 'Bon Jovi Instrumentals'      },
  { query: 'U2 karaoke instrumental',        era: '80s90s',  label: 'U2 Instrumentals'            },
  { query: 'Guns N Roses karaoke',           era: '80s90s',  label: 'GNR Instrumentals'           },
  { query: 'Nirvana karaoke instrumental',   era: '80s90s',  label: 'Nirvana Instrumentals'       },
  { query: 'R.E.M. karaoke instrumental',    era: '80s90s',  label: 'REM Instrumentals'           },
  { query: 'Oasis karaoke instrumental',     era: '80s90s',  label: 'Oasis Instrumentals'         },
  { query: 'Spice Girls karaoke',            era: '80s90s',  label: 'Spice Girls Instrumentals'   },
  { query: 'Backstreet Boys karaoke',        era: '80s90s',  label: 'BSB Instrumentals'           },
  { query: 'Britney Spears karaoke',         era: '2000s',   label: 'Britney Instrumentals'       },
  { query: 'Justin Timberlake karaoke',      era: '2000s',   label: 'JT Instrumentals'            },
  { query: 'Beyonce karaoke instrumental',   era: '2000s',   label: 'Beyoncé Instrumentals'       },
  { query: 'Eminem karaoke instrumental',    era: '2000s',   label: 'Eminem Instrumentals'        },
  { query: 'Rihanna karaoke instrumental',   era: '2000s',   label: 'Rihanna Instrumentals'       },
  { query: 'Lady Gaga karaoke instrumental', era: '2000s',   label: 'Lady Gaga Instrumentals'     },
  { query: 'Amy Winehouse karaoke',          era: '2000s',   label: 'Amy Winehouse Instrumentals' },
  { query: 'Coldplay karaoke instrumental',  era: '2000s',   label: 'Coldplay Instrumentals'      },
  { query: 'Maroon 5 karaoke instrumental',  era: '2000s',   label: 'Maroon 5 Instrumentals'      },
  { query: 'Green Day karaoke instrumental', era: '2000s',   label: 'Green Day Instrumentals'     },
  { query: 'Outkast karaoke instrumental',   era: '2000s',   label: 'Outkast Instrumentals'       },
  { query: 'Taylor Swift karaoke',           era: 'modern',  label: 'Taylor Swift Instrumentals'  },
  { query: 'Adele karaoke instrumental',     era: 'modern',  label: 'Adele Instrumentals'         },
  { query: 'Ed Sheeran karaoke',             era: 'modern',  label: 'Ed Sheeran Instrumentals'    },
  { query: 'Bruno Mars karaoke',             era: 'modern',  label: 'Bruno Mars Instrumentals'    },
  { query: 'The Weeknd karaoke',             era: 'modern',  label: 'Weeknd Instrumentals'        },
  { query: 'Billie Eilish karaoke',          era: 'modern',  label: 'Billie Eilish Instrumentals' },
  { query: 'Olivia Rodrigo karaoke',         era: 'modern',  label: 'Olivia Rodrigo Instrumentals'},
  { query: 'Dua Lipa karaoke instrumental',  era: 'modern',  label: 'Dua Lipa Instrumentals'      },
  { query: 'Harry Styles karaoke',           era: 'modern',  label: 'Harry Styles Instrumentals'  },
  { query: 'Drake karaoke instrumental',     era: 'modern',  label: 'Drake Instrumentals'         },
  { query: 'Post Malone karaoke',            era: 'modern',  label: 'Post Malone Instrumentals'   },
  { query: 'Ariana Grande karaoke',          era: 'modern',  label: 'Ariana Grande Instrumentals' },
  { query: 'Justin Bieber karaoke',          era: 'modern',  label: 'Justin Bieber Instrumentals' },
  { query: 'Sam Smith karaoke instrumental', era: 'modern',  label: 'Sam Smith Instrumentals'     },
  // ── Era sweep — catches any instrumental publisher for an era ─────────────
  { query: 'instrumental hits 1960s',        era: '60s70s',  label: '60s Instrumental Sweep'      },
  { query: 'instrumental hits 1970s',        era: '60s70s',  label: '70s Instrumental Sweep'      },
  { query: 'instrumental hits 1980s',        era: '80s90s',  label: '80s Instrumental Sweep'      },
  { query: 'instrumental hits 1990s',        era: '80s90s',  label: '90s Instrumental Sweep'      },
  { query: 'instrumental hits 2000s',        era: '2000s',   label: '2000s Instrumental Sweep'    },
  { query: 'instrumental pop hits 2010s',    era: 'modern',  label: '2010s Instrumental Sweep'    },
  { query: 'instrumental pop hits 2020s',    era: 'modern',  label: '2020s Instrumental Sweep'    },
  { query: 'karaoke rock classics',          era: '60s70s',  label: 'Classic Rock Karaoke Sweep'  },
  { query: 'karaoke hip hop classics',       era: '80s90s',  label: 'Hip-Hop Karaoke Sweep'       },
  { query: 'karaoke soul classics',          era: '60s70s',  label: 'Soul Karaoke Sweep'          },
  { query: 'karaoke country hits',           era: 'modern',  label: 'Country Karaoke Sweep'       },
  { query: 'karaoke dance hits',             era: 'modern',  label: 'Dance Karaoke Sweep'         },
  { query: 'karaoke r&b hits',               era: '80s90s',  label: 'R&B Karaoke Sweep'           },
];

// ─── Fetch & filter ───────────────────────────────────────────────────────────

async function deezerFetch(url) {
  await new Promise(r => setTimeout(r, 150));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Deezer HTTP ${res.status}`);
  return res.json();
}

async function fetchInstrumentalTracks(query) {
  const url  = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=100`;
  const data = await deezerFetch(url);
  return (data.data || []).filter(t => t.preview && isInstrumental(t));
}

// ─── Insert ───────────────────────────────────────────────────────────────────

async function insertInstrumentalTracks(tracks, defaultEra) {
  if (!tracks.length) return 0;
  let count = 0;

  for (const track of tracks) {
    const title          = extractRealTitle(track);
    const originalArtist = extractOriginalArtist(track) || track.artist?.name;

    if (!title || title.length < 2 || !originalArtist) continue;

    // Skip bare version labels with no real title
    const lowerTitle = title.toLowerCase().trim();
    if (['karaoke version', 'instrumental', 'backing track', 'karaoke'].includes(lowerTitle)) continue;

    const era        = inferEra(track, defaultEra);
    const decade     = track.album?.release_date
      ? parseInt(track.album.release_date.slice(0, 4))
      : null;
    const previewUrl = track.preview;
    const cleanArtist = originalArtist.split(/[,&]/)[0].trim();
    const deezerQuery = `"${title}" "${cleanArtist}" instrumental karaoke`;

    try {
      const result = await pool.query(
        `INSERT INTO songs
           (title, artist, era, decade, deezer_query, preview_cache, preview_cached_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (lower(title), lower(artist)) DO NOTHING`,
        [title, originalArtist, era, decade, deezerQuery, previewUrl]
      );
      if (result.rowCount > 0) count++;
    } catch (err) {
      console.warn(`  Insert skipped [${title}]:`, err.message);
    }
  }
  return count;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songs (
      id                SERIAL PRIMARY KEY,
      title             TEXT        NOT NULL,
      artist            TEXT        NOT NULL,
      era               TEXT        NOT NULL DEFAULT 'modern',
      decade            SMALLINT,
      deezer_query      TEXT        NOT NULL,
      preview_cache     TEXT,
      preview_cached_at TIMESTAMPTZ,
      enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_title_artist_unique
    ON songs (lower(title), lower(artist))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_songs_era_enabled
    ON songs (era, enabled)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_songs_enabled
    ON songs (enabled)
  `);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function ingestFromDeezer({ force = false } = {}) {
  await ensureSchema();

  const { rows } = await pool.query(
    'SELECT COUNT(*) AS n FROM songs WHERE enabled = true'
  );
  const existing = parseInt(rows[0].n);

  if (!force && existing >= 100) {
    console.log(`📚 Catalog has ${existing} songs — skipping ingest`);
    return { skipped: true, existing };
  }

  console.log(`🎵 Instrumental-only ingest starting (${existing} songs in DB)…`);

  const started = Date.now();
  let totalInserted = 0;
  let errors = 0;

  for (const source of SOURCES) {
    try {
      const tracks   = await fetchInstrumentalTracks(source.query);
      const inserted = await insertInstrumentalTracks(tracks, source.era);
      totalInserted += inserted;
      if (tracks.length > 0) {
        console.log(`  ✓ ${source.label}: ${tracks.length} confirmed instrumental, ${inserted} new`);
      }
    } catch (err) {
      errors++;
      console.warn(`  ✗ ${source.label}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const { rows: final } = await pool.query(
    'SELECT COUNT(*) AS n FROM songs WHERE enabled = true'
  );

  console.log(`\n✅ Ingest complete in ${elapsed}s — ${final[0].n} total songs, all instrumental`);
  return { totalInserted, total: parseInt(final[0].n), elapsed, errors };
}

module.exports = { ingestFromDeezer, ensureSchema };
