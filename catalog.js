/**
 * catalog.js — Deezer ingestion engine
 *
 * Pulls tracks directly from Deezer's public API (no auth needed):
 *   - Global charts
 *   - Genre-specific charts (pop, rock, hip-hop, r&b, dance, etc.)
 *   - Decade-tagged editorial playlists
 *   - Keyword searches for underrepresented eras
 *
 * All tracks that have a preview URL are inserted into the `songs` table.
 * Duplicate detection is done by (title, artist) — existing rows are skipped.
 *
 * Called automatically on server startup if the DB is empty.
 * Can also be triggered via GET /api/admin/ingest (protected by ADMIN_SECRET).
 */

const pool = require('./db');

// ─── Deezer source definitions ────────────────────────────────────────────────
//
// Each source is one of:
//   { type: 'playlist', id, era }        → fetch all tracks from a playlist
//   { type: 'chart',    genreId, era }   → fetch chart tracks for a genre
//   { type: 'search',   query, era }     → keyword search, good for filling eras
//
// Deezer playlist IDs for well-known charts / editorial collections:
//   3155776842  — Deezer Global Top Charts
//   1111141961  — Hot Hits USA
//   1362450531  — Pop Rising
//   1282516842  — Rock Classics
//   1313621735  — Hip-Hop Classics
//   1282517382  — R&B Soul
//   1282514582  — Dance Classics
//   1235039    — 60s Hits
//   4523119    — 70s Hits
//   1180612    — 80s Hits
//   927209     — 90s Hits
//   4523199    — 2000s Hits
//   4523169    — 2010s Hits
//
// Deezer genre IDs (for chart endpoint api.deezer.com/chart/<genreId>/tracks):
//   0   — Overall
//   132 — Pop
//   152 — Rock
//   116 — Rap/Hip-Hop
//   165 — R&B
//   113 — Dance
//   106 — Electro
//   85  — Alternative
//   98  — Country

const SOURCES = [
  // ── Global & current charts ──────────────────────────────────────────────────
  { type: 'chart',    genreId: 0,   era: 'modern',  label: 'Global Top Chart'       },
  { type: 'chart',    genreId: 132, era: 'modern',  label: 'Pop Chart'              },
  { type: 'chart',    genreId: 152, era: 'modern',  label: 'Rock Chart'             },
  { type: 'chart',    genreId: 116, era: 'modern',  label: 'Hip-Hop Chart'          },
  { type: 'chart',    genreId: 165, era: 'modern',  label: 'R&B Chart'              },
  { type: 'chart',    genreId: 113, era: 'modern',  label: 'Dance Chart'            },
  { type: 'chart',    genreId: 85,  era: 'modern',  label: 'Alternative Chart'      },
  { type: 'chart',    genreId: 98,  era: 'modern',  label: 'Country Chart'          },

  // ── Editorial playlists — modern hits ────────────────────────────────────────
  { type: 'playlist', id: 3155776842, era: 'modern',  label: 'Deezer Global Top'    },
  { type: 'playlist', id: 1111141961, era: 'modern',  label: 'Hot Hits USA'         },
  { type: 'playlist', id: 1362450531, era: 'modern',  label: 'Pop Rising'           },

  // ── Editorial playlists — decades ────────────────────────────────────────────
  { type: 'playlist', id: 1282516842, era: '80s90s',  label: 'Rock Classics'        },
  { type: 'playlist', id: 1313621735, era: '80s90s',  label: 'Hip-Hop Classics'     },
  { type: 'playlist', id: 1282517382, era: '80s90s',  label: 'R&B Soul'             },
  { type: 'playlist', id: 1282514582, era: '60s70s',  label: 'Dance Classics'       },
  { type: 'playlist', id: 1235039,    era: '60s70s',  label: '60s Hits'             },
  { type: 'playlist', id: 4523119,    era: '60s70s',  label: '70s Hits'             },
  { type: 'playlist', id: 1180612,    era: '80s90s',  label: '80s Hits'             },
  { type: 'playlist', id: 927209,     era: '80s90s',  label: '90s Hits'             },
  { type: 'playlist', id: 4523199,    era: '2000s',   label: '2000s Hits'           },
  { type: 'playlist', id: 4523169,    era: 'modern',  label: '2010s Hits'           },

  // ── Keyword searches — fill gaps in each era ─────────────────────────────────
  // These cast a wide net; the decade field is set from the query context.
  { type: 'search', query: 'top hits 1960s',         era: '60s70s', label: '60s search' },
  { type: 'search', query: 'greatest songs 1970s',   era: '60s70s', label: '70s search' },
  { type: 'search', query: 'best songs 1980s',       era: '80s90s', label: '80s search' },
  { type: 'search', query: 'greatest hits 1990s',    era: '80s90s', label: '90s search' },
  { type: 'search', query: 'top songs 2000s',        era: '2000s',  label: '2000s search' },
  { type: 'search', query: 'best pop songs 2010s',   era: 'modern', label: '2010s search' },
  { type: 'search', query: 'biggest hits 2020s',     era: 'modern', label: '2020s search' },
  { type: 'search', query: 'classic rock hits',      era: '60s70s', label: 'Classic rock' },
  { type: 'search', query: 'golden era hip hop',     era: '80s90s', label: 'Golden hip-hop' },
  { type: 'search', query: 'classic soul R&B',       era: '60s70s', label: 'Classic soul' },
  { type: 'search', query: 'classic pop songs',      era: '80s90s', label: 'Classic pop'  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Throttled fetch — adds a small delay so we don't hammer Deezer */
async function deezerFetch(url) {
  await new Promise(r => setTimeout(r, 120)); // ~8 req/s
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Deezer ${res.status} for ${url}`);
  return res.json();
}

/** Classify an era from Deezer track data if we don't already have one */
function inferEra(track, defaultEra) {
  // Use the album release date if present
  const year = track.album?.release_date
    ? parseInt(track.album.release_date.slice(0, 4))
    : null;

  if (!year) return defaultEra;
  if (year < 1980) return '60s70s';
  if (year < 2000) return '80s90s';
  if (year < 2010) return '2000s';
  return 'modern';
}

/** Build the karaoke/instrumental search query stored in deezer_query */
function buildQuery(title, artist) {
  // Strip featured artists from title for cleaner searches
  const cleanTitle  = title.replace(/\s*[\(\[]?feat\..*$/i, '').trim();
  const cleanArtist = artist.split(/[,&]/)[0].trim(); // take first if multiple
  return `artist:"${cleanArtist}" track:"${cleanTitle}" karaoke`;
}

/** Fetch tracks from a Deezer chart endpoint */
async function fetchChart(genreId) {
  const url = `https://api.deezer.com/chart/${genreId}/tracks?limit=100`;
  const data = await deezerFetch(url);
  return (data.data || []).filter(t => t.preview);
}

/** Fetch tracks from a Deezer playlist */
async function fetchPlaylist(playlistId) {
  // Playlists can be paginated — fetch up to 200 tracks
  const tracks = [];
  let url = `https://api.deezer.com/playlist/${playlistId}/tracks?limit=100`;
  while (url && tracks.length < 200) {
    const data = await deezerFetch(url);
    (data.data || []).filter(t => t.preview).forEach(t => tracks.push(t));
    url = data.next || null;
  }
  return tracks;
}

/** Fetch tracks from a Deezer search query */
async function fetchSearch(query) {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=100`;
  const data = await deezerFetch(url);
  return (data.data || []).filter(t => t.preview);
}

/** Insert a batch of Deezer tracks into the songs table. Returns insert count. */
async function insertTracks(tracks, defaultEra) {
  if (!tracks.length) return 0;
  let count = 0;

  for (const track of tracks) {
    const title  = track.title_short || track.title;
    const artist = track.artist?.name;
    if (!title || !artist) continue;

    const era          = inferEra(track, defaultEra);
    const decade       = track.album?.release_date
      ? parseInt(track.album.release_date.slice(0, 4))
      : null;
    const deezerQuery  = buildQuery(title, artist);
    // Store the known-good preview directly — no need to re-search later
    const previewCache = track.preview;

    try {
      const result = await pool.query(
        `INSERT INTO songs
           (title, artist, era, decade, deezer_query, preview_cache, preview_cached_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (lower(title), lower(artist)) DO NOTHING`,
        [title, artist, era, decade, deezerQuery, previewCache]
      );
      if (result.rowCount > 0) count++;
    } catch (err) {
      // Log but don't abort — one bad row shouldn't stop the batch
      console.warn(`  Insert skipped [${title} — ${artist}]:`, err.message);
    }
  }
  return count;
}

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

async function ensureSchema() {
  // pg does not support multiple statements in one query() call.
  // Each DDL statement must be issued separately.

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

// ─── Main ingestion function ──────────────────────────────────────────────────

async function ingestFromDeezer({ force = false } = {}) {
  await ensureSchema();

  // Check how many songs we already have
  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM songs WHERE enabled = true');
  const existing = parseInt(rows[0].n);

  if (!force && existing >= 100) {
    console.log(`📚 Catalog already has ${existing} songs — skipping ingest`);
    return { skipped: true, existing };
  }

  console.log(`🎵 Starting Deezer catalog ingest (${existing} songs currently in DB)…`);
  const started = Date.now();
  let totalInserted = 0;
  let errors = 0;

  for (const source of SOURCES) {
    try {
      let tracks = [];

      if (source.type === 'chart') {
        tracks = await fetchChart(source.genreId);
      } else if (source.type === 'playlist') {
        tracks = await fetchPlaylist(source.id);
      } else if (source.type === 'search') {
        tracks = await fetchSearch(source.query);
      }

      const inserted = await insertTracks(tracks, source.era);
      totalInserted += inserted;
      console.log(`  ✓ ${source.label}: ${tracks.length} tracks fetched, ${inserted} new`);

    } catch (err) {
      errors++;
      console.warn(`  ✗ ${source.label}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const { rows: final } = await pool.query('SELECT COUNT(*) AS n FROM songs WHERE enabled = true');

  console.log(`\n✅ Ingest complete in ${elapsed}s`);
  console.log(`   New songs inserted: ${totalInserted}`);
  console.log(`   Total catalog size: ${final[0].n}`);
  console.log(`   Sources with errors: ${errors}`);

  return { totalInserted, total: parseInt(final[0].n), elapsed, errors };
}

module.exports = { ingestFromDeezer, ensureSchema };
