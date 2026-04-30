import compression from 'compression';
import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.API_PORT || 3001);
const dbPath = process.env.AIS_DB_PATH || 'D:\\Projects\\ais\\data\\ais0416.db';

if (!existsSync(dbPath)) {
  console.error(`AIS_DB_PATH does not exist: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const app = express();

app.use(cors());
app.use(compression());

function getTrackTables() {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'locus%' ORDER BY name"
    )
    .all()
    .map((row) => row.name)
    .filter((name) => /^locus\d{8}$/.test(name));
}

function q(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function colorForMmsi(mmsi) {
  let hash = 0;
  for (let i = 0; i < mmsi.length; i += 1) {
    hash = (hash * 31 + mmsi.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 78%, 52%)`;
}

function sourceSql() {
  const tables = getTrackTables();
  return tables.map((table) => `SELECT * FROM ${q(table)}`).join(' UNION ALL ');
}

function normalizeTimeInput(value) {
  if (!value) return null;
  const input = String(value).trim();
  const match = input.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/);
  if (!match) {
    const error = new Error(`Invalid datetime: ${value}`);
    error.status = 400;
    throw error;
  }

  const [, date, hour, minute = '00', second = '00'] = match;
  return `${date} ${hour}:${minute}:${second}`;
}

function getTimeWindow(req) {
  const start = normalizeTimeInput(req.query.start);
  const end = normalizeTimeInput(req.query.end);
  if (start && end && start > end) {
    const error = new Error('start must be earlier than or equal to end');
    error.status = 400;
    throw error;
  }
  return { start, end };
}

function buildTimeClause(alias, window, params) {
  const conditions = [];
  if (window.start) {
    conditions.push(`${alias}.jssj >= ?`);
    params.push(window.start);
  }
  if (window.end) {
    conditions.push(`${alias}.jssj <= ?`);
    params.push(window.end);
  }
  return conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
}

function getGlobalBounds() {
  return db
    .prepare(
      `SELECT
        COUNT(*) AS rows,
        COUNT(DISTINCT mmsi) AS ships,
        MIN(jssj) AS minTime,
        MAX(jssj) AS maxTime,
        MIN(zbjd) AS minLon,
        MIN(zbwd) AS minLat,
        MAX(zbjd) AS maxLon,
        MAX(zbwd) AS maxLat
      FROM (${sourceSql()})`
    )
    .get();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, dbPath });
});

app.get('/api/time-bounds', (_req, res, next) => {
  try {
    const bounds = getGlobalBounds();
    res.json({
      dbPath,
      ...bounds
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ships/search', (req, res, next) => {
  try {
    const keyword = String(req.query.q || '').trim();
    if (!keyword) {
      res.json({ results: [] });
      return;
    }

    const window = getTimeWindow(req);
    const like = `%${keyword.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const params = [like, like, like];
    const timeClause = buildTimeClause('l', window, params);

    const results = db
      .prepare(
        `SELECT
          l.mmsi AS mmsi,
          COALESCE(NULLIF(s.zwmc, ''), NULLIF(s.cbmc, ''), l.mmsi) AS shipName,
          COUNT(*) AS pointCount,
          MIN(l.jssj) AS minTime,
          MAX(l.jssj) AS maxTime
        FROM (${sourceSql()}) l
        LEFT JOIN ship s ON s.mmsi = l.mmsi
        WHERE (
          l.mmsi LIKE ? ESCAPE '\\'
          OR s.zwmc LIKE ? ESCAPE '\\'
          OR s.cbmc LIKE ? ESCAPE '\\'
        )${timeClause}
        GROUP BY l.mmsi, shipName
        ORDER BY pointCount DESC, l.mmsi
        LIMIT 20`
      )
      .all(...params);

    res.json({ results });
  } catch (error) {
    next(error);
  }
});

app.get('/api/tracks', (req, res, next) => {
  try {
    const window = getTimeWindow(req);
    const params = [];
    const timeClause = buildTimeClause('l', window, params);

    const rows = db
      .prepare(
        `SELECT
          l.mmsi,
          l.jssj,
          l.zbjd,
          l.zbwd,
          l.dqhs,
          l.cbhx,
          l.cbcs,
          l.class_type AS classType,
          COALESCE(NULLIF(s.zwmc, ''), NULLIF(s.cbmc, ''), l.mmsi) AS shipName
        FROM (${sourceSql()}) l
        LEFT JOIN ship s ON s.mmsi = l.mmsi
        WHERE l.zbjd IS NOT NULL
          AND l.zbwd IS NOT NULL
          AND l.zbjd BETWEEN -180 AND 180
          AND l.zbwd BETWEEN -90 AND 90${timeClause}
        ORDER BY l.mmsi, l.jssj`
      )
      .all(...params);

    const ships = new Map();
    const pointFeatures = [];
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    let minTime = null;
    let maxTime = null;

    for (const row of rows) {
      const lon = Number(row.zbjd);
      const lat = Number(row.zbwd);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
      minTime = minTime ? (row.jssj < minTime ? row.jssj : minTime) : row.jssj;
      maxTime = maxTime ? (row.jssj > maxTime ? row.jssj : maxTime) : row.jssj;

      const mmsi = String(row.mmsi);
      const color = colorForMmsi(mmsi);

      if (!ships.has(mmsi)) {
        ships.set(mmsi, {
          mmsi,
          shipName: row.shipName || mmsi,
          color,
          coordinates: [],
          lastTime: null,
          lastCoordinate: null,
          pointCount: 0
        });
      }

      const ship = ships.get(mmsi);
      const coordinate = [lon, lat];
      ship.coordinates.push(coordinate);
      ship.lastTime = row.jssj;
      ship.lastCoordinate = coordinate;
      ship.pointCount += 1;

      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coordinate },
        properties: {
          mmsi,
          shipName: ship.shipName,
          time: row.jssj,
          speed: row.dqhs,
          heading: row.cbhx,
          classType: row.classType,
          color
        }
      });
    }

    const lineFeatures = [];
    const labelFeatures = [];
    for (const ship of ships.values()) {
      if (ship.coordinates.length >= 2) {
        lineFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: ship.coordinates },
          properties: {
            mmsi: ship.mmsi,
            shipName: ship.shipName,
            color: ship.color,
            pointCount: ship.pointCount
          }
        });
      }

      if (ship.lastCoordinate) {
        labelFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: ship.lastCoordinate },
          properties: {
            mmsi: ship.mmsi,
            shipName: ship.shipName,
            color: ship.color,
            pointCount: ship.pointCount,
            lastTime: ship.lastTime
          }
        });
      }
    }

    const bbox =
      Number.isFinite(minLon) && Number.isFinite(minLat) && Number.isFinite(maxLon) && Number.isFinite(maxLat)
        ? [minLon, minLat, maxLon, maxLat]
        : null;

    res.json({
      window,
      summary: {
        rows: pointFeatures.length,
        ships: ships.size,
        lines: lineFeatures.length,
        labels: labelFeatures.length,
        bbox,
        minTime,
        maxTime
      },
      lines: { type: 'FeatureCollection', features: lineFeatures },
      points: { type: 'FeatureCollection', features: pointFeatures },
      labels: { type: 'FeatureCollection', features: labelFeatures }
    });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(rootDir, 'dist')));

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || 'Internal server error'
  });
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

app.listen(port, () => {
  console.log(`AIS API server listening on http://localhost:${port}`);
});
