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
const trackTables = getTrackTables();
const routeDensityBandwidth = 150;
const routeDensityRadius = 450;
const earthRadiusMeters = 6378137;

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

function lonLatToMeters(lon, lat) {
  const x = earthRadiusMeters * (lon * Math.PI / 180);
  const y = earthRadiusMeters * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
  return [x, y];
}

function gridKey(x, y, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

function addToGrid(grid, segment, cellSize) {
  const key = gridKey(segment.midX, segment.midY, cellSize);
  const bucket = grid.get(key);
  if (bucket) {
    bucket.push(segment);
    return;
  }
  grid.set(key, [segment]);
}

function nearbyBuckets(grid, x, y, cellSize, radius) {
  const centerX = Math.floor(x / cellSize);
  const centerY = Math.floor(y / cellSize);
  const range = Math.ceil(radius / cellSize);
  const buckets = [];

  for (let gx = centerX - range; gx <= centerX + range; gx += 1) {
    for (let gy = centerY - range; gy <= centerY + range; gy += 1) {
      const bucket = grid.get(`${gx}:${gy}`);
      if (bucket) buckets.push(bucket);
    }
  }

  return buckets;
}

function createRouteSegments(rows) {
  const segments = [];
  let previous = null;

  for (const row of rows) {
    const lon = Number(row.zbjd);
    const lat = Number(row.zbwd);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const current = {
      mmsi: String(row.mmsi),
      time: row.jssj,
      coordinate: [lon, lat]
    };

    if (previous && previous.mmsi === current.mmsi) {
      const midpoint = [
        (previous.coordinate[0] + current.coordinate[0]) / 2,
        (previous.coordinate[1] + current.coordinate[1]) / 2
      ];
      const [midX, midY] = lonLatToMeters(midpoint[0], midpoint[1]);

      segments.push({
        mmsi: current.mmsi,
        fromTime: previous.time,
        toTime: current.time,
        coordinates: [previous.coordinate, current.coordinate],
        midpoint,
        midX,
        midY,
        density: 0,
        normalizedDensity: 0
      });
    }

    previous = current;
  }

  return segments;
}

function applyRouteDensity(segments, bandwidth = routeDensityBandwidth, radius = routeDensityRadius) {
  const grid = new Map();
  const radiusSq = radius * radius;
  const bandwidthFactor = 2 * bandwidth * bandwidth;
  let maxDensity = 0;

  for (const segment of segments) {
    addToGrid(grid, segment, radius);
  }

  for (const segment of segments) {
    let density = 0;
    const buckets = nearbyBuckets(grid, segment.midX, segment.midY, radius, radius);

    for (const bucket of buckets) {
      for (const candidate of bucket) {
        const dx = segment.midX - candidate.midX;
        const dy = segment.midY - candidate.midY;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq > radiusSq) continue;
        density += Math.exp(-distanceSq / bandwidthFactor);
      }
    }

    segment.density = density;
    maxDensity = Math.max(maxDensity, density);
  }

  const maxLogDensity = Math.log1p(maxDensity);
  for (const segment of segments) {
    segment.normalizedDensity = maxLogDensity ? Math.log1p(segment.density) / maxLogDensity : 0;
  }

  return { cells: grid.size, maxDensity };
}

function routeSegmentFeature(segment) {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: segment.coordinates
    },
    properties: {
      mmsi: segment.mmsi,
      fromTime: segment.fromTime,
      toTime: segment.toTime,
      density: segment.density,
      normalizedDensity: segment.normalizedDensity
    }
  };
}

function shiftDate(date, days) {
  const nextDate = new Date(`${date}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate.toISOString().slice(0, 10);
}

function getTableDate(table) {
  const match = table.match(/^locus(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function getTrackTablesForWindow(window) {
  if (!window.start && !window.end) return trackTables;

  const startDate = window.start ? shiftDate(window.start.slice(0, 10), -1) : null;
  const endDate = window.end ? window.end.slice(0, 10) : null;

  return trackTables.filter((table) => {
    const tableDate = getTableDate(table);
    if (!tableDate) return false;
    if (startDate && tableDate < startDate) return false;
    if (endDate && tableDate > endDate) return false;
    return true;
  });
}

function sourceSql(tables = trackTables) {
  if (!tables.length) return `SELECT * FROM ${q(trackTables[0])} WHERE 0`;
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
    const tables = getTrackTablesForWindow(window);
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
        FROM (${sourceSql(tables)}) l
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
    const requestStart = performance.now();
    const window = getTimeWindow(req);
    const tables = getTrackTablesForWindow(window);
    const params = [];
    const timeClause = buildTimeClause('l', window, params);

    const sqlStart = performance.now();
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
        FROM (${sourceSql(tables)}) l
        LEFT JOIN ship s ON s.mmsi = l.mmsi
        WHERE l.zbjd IS NOT NULL
          AND l.zbwd IS NOT NULL
          AND l.zbjd BETWEEN -180 AND 180
          AND l.zbwd BETWEEN -90 AND 90${timeClause}
        ORDER BY l.mmsi, l.jssj`
      )
      .all(...params);
    const sqlMs = performance.now() - sqlStart;

    const buildStart = performance.now();
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

    const payload = {
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
    };
    const buildMs = performance.now() - buildStart;
    const responseStart = performance.now();

    res.once('finish', () => {
      console.log(
        JSON.stringify({
          route: '/api/tracks',
          tables,
          sqlMs: Math.round(sqlMs),
          buildMs: Math.round(buildMs),
          responseMs: Math.round(performance.now() - responseStart),
          totalMs: Math.round(performance.now() - requestStart),
          dbRows: rows.length,
          pointFeatures: pointFeatures.length,
          lineFeatures: lineFeatures.length
        })
      );
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get('/api/route-segments', (req, res, next) => {
  try {
    const requestStart = performance.now();
    const window = getTimeWindow(req);
    const tables = getTrackTablesForWindow(window);
    const params = [];
    const timeClause = buildTimeClause('l', window, params);

    const sqlStart = performance.now();
    const rows = db
      .prepare(
        `SELECT
          l.mmsi,
          l.jssj,
          l.zbjd,
          l.zbwd
        FROM (${sourceSql(tables)}) l
        WHERE l.zbjd IS NOT NULL
          AND l.zbwd IS NOT NULL
          AND l.zbjd BETWEEN -180 AND 180
          AND l.zbwd BETWEEN -90 AND 90${timeClause}
        ORDER BY l.mmsi, l.jssj`
      )
      .all(...params);
    const sqlMs = performance.now() - sqlStart;

    const segmentStart = performance.now();
    const segments = createRouteSegments(rows);
    const segmentMs = performance.now() - segmentStart;

    const densityStart = performance.now();
    const densitySummary = applyRouteDensity(segments);
    const densityMs = performance.now() - densityStart;

    const payload = {
      window,
      summary: {
        rows: rows.length,
        segments: segments.length,
        cells: densitySummary.cells,
        maxDensity: densitySummary.maxDensity,
        bandwidth: routeDensityBandwidth,
        radius: routeDensityRadius
      },
      segments: {
        type: 'FeatureCollection',
        features: segments.map(routeSegmentFeature)
      }
    };
    const responseStart = performance.now();

    res.once('finish', () => {
      console.log(
        JSON.stringify({
          route: '/api/route-segments',
          tables,
          sqlMs: Math.round(sqlMs),
          segmentMs: Math.round(segmentMs),
          densityMs: Math.round(densityMs),
          responseMs: Math.round(performance.now() - responseStart),
          totalMs: Math.round(performance.now() - requestStart),
          dbRows: rows.length,
          segments: segments.length
        })
      );
    });

    res.json(payload);
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
