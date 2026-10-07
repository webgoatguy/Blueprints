# Hex Blueprints — online multiplayer

Red vs Blue on an endless hex grid. Create a game, send your friend the link, and play.
Other people who open the link can watch. Pass-and-play on one device is still included.

This is a small Vercel project: a static page plus one serverless function. Games are
stored in Redis.

```
hex-blueprints/
├─ public/
│  ├─ index.html     page layout and styles
│  ├─ client.js      the game UI (lobby, board, online sync)
│  └─ rules.js       game rules, shared by the browser AND the server
├─ api/
│  └─ game.js        the API: create / join / poll / move / take back
├─ lib/
│  └─ store.js       Redis connection (Upstash or any REDIS_URL)
├─ dev-server.mjs    local test server (npm run dev)
└─ package.json
```

---

## Deploy to Vercel (about 10 minutes)

### 1. Put the code on Vercel

**Option A: GitHub (recommended)**
1. Create a new GitHub repository and upload the contents of this folder (not the zip itself).
2. On vercel.com: **Add New… → Project**, then import that repository.
3. Leave every setting at its default. The Framework Preset is **Other**, and there is no
   build command or output directory to set. Click **Deploy**.

**Option B: Vercel CLI**
```bash
npm i -g vercel
cd hex-blueprints
vercel          # answer the prompts and accept the defaults
```

The first deploy succeeds, but online games won't work until Redis is connected (next step).

### 2. Connect a Redis database
1. Open your project on Vercel and go to the **Storage** tab.
2. Click **Create Database** (or browse the Marketplace) and pick a Redis provider:
   - **Upstash for Redis**: has a free plan and works well with serverless.
   - **Redis** (Redis Cloud): also works.
3. Create it, then **Connect** it to this project for all environments
   (Production, Preview, Development). **Leave the environment-variable prefix empty or at its default.**

The code finds the database by itself. It looks for either `KV_REST_API_URL` + `KV_REST_API_TOKEN`
(Upstash; `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` also work) or `REDIS_URL`.

### 3. Redeploy
Environment variables only reach new deployments. Go to **Deployments**, open the latest one's
**⋯** menu and choose **Redeploy** (or run `vercel --prod` again).

### 4. Play
Open your site, enter a name, pick a colour and click **Create game & get invite link**.
Send the link to a friend. The first person to open it takes the other seat.

---

## Game options

The **Game options** section is on the home screen. Your choice applies to games you create
online and to pass-and-play. It's remembered in your browser, and it's saved with each game,
so your friend and the server always play by the same rules.

| Option | Choices | Default |
|---|---|---|
| Turn order | **1 · 2 · 2 · 2 …**: Blue 1 move, then 2 moves each<br>**1 · 1 · 1 · 1 …**: alternate single moves | 1 · 2 · 2 · 2 … |
| Points for destroying an enemy Score cell | 0–20 | 2 |

Score = your Score cells on the board + (enemy Score cells you destroyed × that number).
You can see a game's options in **Rules**, in **Menu**, and in the join dialog your friend sees.
Games created before these options existed keep their original rules (1 point, 1 · 2 · 2 turns).

## How online play works

- **The server checks every move.** `api/game.js` runs each move through the same
  `public/rules.js` the browser uses before saving it, so a modified browser can't cheat.
- **Seats are private.** When you create or join a game, the server gives your browser a secret
  token (Redis only stores a hash of it). It's saved in your browser, so refreshing keeps your seat.
  To continue on another device, use **Menu → Copy my rejoin link**. Anyone who has that link can
  play as you, so keep it private.
- **Opponent moves appear automatically.** The page asks the server for updates about every
  1.5 seconds while you're waiting, every 4 seconds on your own turn, and every 20 seconds when the
  tab is in the background. Each check is a single Redis read.
- **Moves can't collide.** Each save is an atomic compare-and-set in Redis, so a double-click or two
  tabs can never apply a move twice.
- **Take back** undoes your own last move, as long as your opponent hasn't moved since.
- **Games expire** after 60 days with no activity.
- **Spectators**: once both seats are taken, anyone else who opens the link can watch.

**Free-plan usage:** the polling costs roughly 1,500–2,500 Redis commands per hour for each open
game tab. That's fine for casual games with friends, but if you use a free Redis plan, keep an eye on
its monthly command limit.

---

## Run it locally

```bash
npm install
npm run dev            # http://localhost:3000
```

Without any Redis settings, the dev server keeps games in memory, so they disappear when it stops.
To test the online flow, open the invite link in a second browser or a private window.

To use your real Vercel database locally:
```bash
vercel link
vercel env pull .env.local
npm run dev:env
```

## Changing the rules

All rules live in `public/rules.js`: the starting blueprints, the turn orders, the game options
(`DEFAULT_SETTINGS`, `normalizeSettings`), what can overwrite what, and scoring. The server and the browser both import it, so one edit changes both.
Existing games are stored as a move log and the current board. A rules change applies to future
moves, so start fresh games after changing anything big.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No Redis database is connected" | Do steps 2 and 3: connect a Redis database, then redeploy. |
| It still says that after connecting | The database was connected with a custom env-variable prefix. Reconnect it without a prefix, or rename the variables to `REDIS_URL` (or `KV_REST_API_URL` / `KV_REST_API_TOKEN`). |
| "Game not found" | Check the code, or the game expired (60 days idle). |
| Opening `index.html` straight from disk doesn't work | The page uses JavaScript modules, which browsers block on `file://`. Use `npm run dev` or the deployed site. |
