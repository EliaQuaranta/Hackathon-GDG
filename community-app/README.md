# Lecce si muove

Custom, mobile-first community mobility prototype. It uses no Fabric services.

## Run locally

Requirements: Node.js 24 or later.

```powershell
npm start
```

Open `http://127.0.0.1:4173`. The local operator demo key is `demo-lecce`. Reports are persisted in a local SQLite file under `data/`; that directory is ignored by Git. Do not expose this local prototype to the public internet.

Run the API and privacy-flow tests with `npm test`. Run TypeScript checks with `npm run typecheck` after installing the development dependencies with `npm install`.

## What works

- Map layers for the supplied cycle network, school locations, and historical incident concentrations.
- Incident points are aggregated into approximately one-kilometre cells and cells with fewer than five records are suppressed.
- Citizens can submit a mobility report with a map location or browser geolocation.
- New reports remain private in the operator queue. A local operator can verify or reject them.
- Verified reports appear on the public map with approximate coordinates and no description.
- A transactional SQLite outbox broadcasts operator and public changes through Server-Sent Events.
- The PWA shell is cached for repeat visits; report submission requires a connection.

## Data and scope limits

The input folder contains several files whose actual content does not match their filename or extension. The loader currently uses the verified local mapping: the historical accident CSV is in `lecce_rete_ciclabile.geojson`, the cycle-network GeoJSON is in `LEGGIMI.docx`, and the school CSV is in `LEGGIMI.md`. Do not rename or overwrite those original files as part of running the app.

The historic datasets are context, not live feeds. School data is from 2017/18 and the cycle-network survey is from 2019. The app does not send notifications to the Polizia Locale and is not an emergency service. Call 112 for immediate danger.

The local implementation uses SQLite for a self-contained demo. `db/postgres.sql` documents the PostgreSQL/PostGIS production schema; it is not yet wired into the running API. A public deployment still needs HTTPS, real operator identity/authorization, abuse controls, data-retention policy, monitoring, backups, and a municipal-approved dispatch integration. Do not use the local demo key in deployment.
