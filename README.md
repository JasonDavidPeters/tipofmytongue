# 🎵 Tip of Your Tongue — Music Trivia

A music trivia game powered by Spotify previews. Players never need a Spotify account — you host the credentials on your server.

---

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Set up your Spotify app
- Go to https://developer.spotify.com/dashboard
- Create a new app (any name)
- **No Redirect URI needed** — we use Client Credentials (server-to-server)
- Copy your **Client ID** and **Client Secret**

### 3. Create your .env file
```bash
cp .env.example .env
```
Edit `.env` and fill in your credentials:
```
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
```

### 4. Run locally
```bash
npm run dev       # development (auto-restarts on file changes)
# or
npm start         # production
```

Open http://localhost:3000 — players can join with no Spotify account needed.

---

## Deploy to Render (Free Hosting)

Render's free tier keeps your server running and is perfect for this game.

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
gh repo create tip-of-your-tongue --public --push
# or push to an existing repo
```

### 2. Create a Render Web Service
- Go to https://render.com and sign in
- Click **New → Web Service**
- Connect your GitHub repo
- Configure:
  - **Name:** tip-of-your-tongue (or anything)
  - **Runtime:** Node
  - **Build Command:** `npm install`
  - **Start Command:** `npm start`
  - **Instance Type:** Free

### 3. Add Environment Variables in Render
In your service dashboard → **Environment** tab, add:
- `SPOTIFY_CLIENT_ID` = your client ID
- `SPOTIFY_CLIENT_SECRET` = your client secret

### 4. Deploy
Render will auto-deploy on every push to main. Share the URL with players — no setup required on their end.

---

## Architecture

```
Player's browser
      │
      │  GET /api/preview?q=Bohemian+Rhapsody+Queen
      ▼
Your Express Server (server.js)
      │  ← holds SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET
      │
      │  POST https://accounts.spotify.com/api/token
      │  GET  https://api.spotify.com/v1/search?q=...
      ▼
  Spotify API
      │
      │  returns preview_url (CDN link to 30s MP3)
      ▼
Your Express Server
      │
      │  returns { previewUrl, trackName, artistName }
      ▼
Player's browser
      │  fetches the MP3 directly from Spotify's CDN
      ▼
  Audio plays 🎵
```

**Key point:** Your Spotify credentials never leave your server. The preview URL returned is a public CDN link — players fetch audio directly from Spotify's CDN, so bandwidth cost to you is zero.

---

## Project Structure

```
tip-of-your-tongue/
├── server.js          # Express server + Spotify proxy
├── package.json
├── .env               # Your secrets (never commit this)
├── .env.example       # Template
├── .gitignore
└── public/
    └── index.html     # The game (served as static file)
```
