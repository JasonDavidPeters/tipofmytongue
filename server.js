/**
 * Tip of Your Tongue — Backend Server
 * Proxies Spotify API requests so players never need to authenticate.
 * Your Spotify credentials stay server-side only.
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Validate env ────────────────────────────────────────────────────────────
const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error('❌  Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env');
  process.exit(1);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves index.html

// ─── Spotify token cache (Client Credentials — no user login needed) ─────────
let cachedToken     = null;
let tokenExpiresAt  = 0;

async function getSpotifyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const creds  = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res    = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Spotify token error: ${res.status} — ${err}`);
  }

  const data       = await res.json();
  cachedToken      = data.access_token;
  tokenExpiresAt   = Date.now() + (data.expires_in - 60) * 1000; // refresh 1 min early
  console.log('🎵  Spotify token refreshed');
  return cachedToken;
}

// ─── API: Search for a track preview ─────────────────────────────────────────
// GET /api/preview?q=Bohemian+Rhapsody+Queen
app.get('/api/preview', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });

  try {
    const token  = await getSpotifyToken();
    const url    = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`;
    const spotRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!spotRes.ok) {
      const err = await spotRes.text();
      return res.status(spotRes.status).json({ error: err });
    }

    const data   = await spotRes.json();
    const tracks = data?.tracks?.items || [];

    // Find the first track that has a preview URL
    for (const track of tracks) {
      if (track.preview_url) {
        return res.json({
          previewUrl:   track.preview_url,
          trackName:    track.name,
          artistName:   track.artists.map(a => a.name).join(', '),
          albumArt:     track.album?.images?.[1]?.url ?? null,
        });
      }
    }

    // No preview available for any result
    return res.json({ previewUrl: null });

  } catch (err) {
    console.error('Preview fetch error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Health check (used by Render to confirm the server is up) ───────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Catch-all: serve the game SPA ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎵  Tip of Your Tongue server running on http://localhost:${PORT}`);
});
