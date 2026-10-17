# RuneScape and OSRS player count

Tracks how many people are playing RuneScape 3 and Old School RuneScape, stores
the history locally, and shows it on a dashboard.

**Live at [rs.arcade.lv](https://rs.arcade.lv).**

```bash
npm start
```

Then open http://localhost:3320. Requires Node 18+; no dependencies.

## How it works

Every 2 minutes the server polls two public Jagex endpoints:

- `runescape.com/player_count.js` — combined RS3 + OSRS online count
- `runescape.com/g=oldscape/slr.ws` — the OSRS world list (binary), summed for
  the OSRS count. It matches the figure on the OSRS homepage.

RS3 = combined − OSRS. It also records each game's Steam player count
(`ISteamUserStats/GetNumberOfCurrentPlayers`, apps 1343400 and 1343370), which
covers only players who launched through Steam. RS3 has no public world list, so
the region/world breakdowns are Old School only. Each sample is appended to `data/samples.jsonl`, so history
survives restarts. History only exists from when you start the tracker; Jagex
doesn't publish past counts.

## Dashboard

- Total, OSRS and RS3 counts now, with each game's share and the range's peak/low
- Line chart over 1h / 6h / 24h / 7d / 30d / all, with hover readout and a table view
- OSRS players by region and by members vs free-to-play
- Sortable, searchable table of every OSRS world

## Config

| Env var   | Default | Meaning                             |
|-----------|---------|-------------------------------------|
| `PORT`    | 3320    | HTTP port                           |
| `POLL_MS` | 120000  | Poll interval in ms (minimum 15000) |

## Deploying with pm2

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

History lives in `data/samples.jsonl` next to `server.js`; keep that folder when
redeploying. Updates: pull the new code, then `pm2 restart rs-tracker`.

## API

- `GET /api/history?range=<ms>` — samples in the last `range` ms (0 = all),
  averaged down to at most 720 points, plus peak/low stats
- `GET /api/worlds` — the latest OSRS world list
