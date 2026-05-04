<script setup>
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer } from '@deck.gl/layers';
import mapboxgl from 'mapbox-gl';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN || '';

const apiUrl = (path) => `${apiBaseUrl}${path}`;
const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(value || 0);
const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });

function dbToInput(value) {
  if (!value) return '';
  return value.slice(0, 13).replace(' ', 'T') + ':00';
}

function inputToDb(value) {
  if (!value) return '';
  return `${value.replace('T', ' ')}:00`;
}

const mapEl = ref(null);
const startTime = ref('');
const endTime = ref('');
const bounds = ref(null);
const loading = ref(false);
const error = ref('');
const summary = ref(null);
const mapReady = ref(false);
const showRouteHeatmap = ref(false);
const focusedMmsi = ref('');
const searchQuery = ref('');
const searchResults = ref([]);
const searchLoading = ref(false);
const searchError = ref('');

let map = null;
let deckOverlay = null;
let currentRequest = 0;
let currentSearchRequest = 0;
let hasAppliedInitialView = false;

const rawData = {
  lines: emptyCollection(),
  points: emptyCollection(),
  labels: emptyCollection()
};
let routeSegments = emptyCollection();

const timeWindowLabel = computed(() => {
  if (!startTime.value || !endTime.value) return '';
  return `${startTime.value.replace('T', ' ')} 至 ${endTime.value.replace('T', ' ')}`;
});

const focusSummary = computed(() => {
  if (!focusedMmsi.value) return '';
  const hit = searchResults.value.find((item) => item.mmsi === focusedMmsi.value);
  if (hit) return `${hit.shipName} (${hit.mmsi})`;

  const labelFeature = rawData.labels.features.find(
    (feature) => feature.properties?.mmsi === focusedMmsi.value
  );
  if (!labelFeature) return focusedMmsi.value;
  return `${labelFeature.properties?.shipName || focusedMmsi.value} (${focusedMmsi.value})`;
});

function cloneFeature(feature) {
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: { ...feature.properties }
  };
}

function decorateCollection(collection) {
  const hasFocus = Boolean(focusedMmsi.value);
  return {
    type: 'FeatureCollection',
    features: (collection?.features || []).map((feature) => {
      const nextFeature = cloneFeature(feature);
      const mmsi = String(nextFeature.properties?.mmsi || '');
      nextFeature.properties.isFocused = hasFocus && mmsi === focusedMmsi.value;
      nextFeature.properties.isDimmed = hasFocus && mmsi !== focusedMmsi.value;
      return nextFeature;
    })
  };
}

function hslToRgb(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb = [0, 0, 0];

  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return rgb.map((channel) => Math.round((channel + m) * 255));
}

function parseColor(color, alpha = 255) {
  const match = String(color || '').match(/^hsl\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)%,\s*(\d+(?:\.\d+)?)%\)$/);
  if (!match) return [25, 118, 210, alpha];
  const [, hue, saturation, lightness] = match;
  return [...hslToRgb(Number(hue) % 360, Number(saturation), Number(lightness)), alpha];
}

function getDeckColor(feature, fallbackAlpha = 220) {
  const properties = feature?.properties || {};
  if (properties.isDimmed) return parseColor(properties.color, 24);
  if (properties.isFocused) return parseColor(properties.color, 245);
  return parseColor(properties.color, fallbackAlpha);
}

function getRouteHeatColor(feature) {
  const density = Math.max(0, Math.min(1, feature?.properties?.normalizedDensity || 0));
  if (density < 0.18) return [49, 130, 189, 95];
  if (density < 0.36) return [65, 182, 196, 135];
  if (density < 0.54) return [102, 194, 165, 175];
  if (density < 0.72) return [254, 224, 139, 215];
  if (density < 0.9) return [253, 141, 60, 238];
  return [215, 48, 39, 255];
}

function getRouteHeatWidth(feature) {
  const density = Math.max(0, Math.min(1, feature?.properties?.normalizedDensity || 0));
  return 1 + density * 5;
}

function setCanvasCursor(cursor) {
  if (map) map.getCanvas().style.cursor = cursor;
}

function handleDeckHover(info) {
  setCanvasCursor(info.object ? 'pointer' : '');
}

function handleDeckClick(info) {
  if (showRouteHeatmap.value) return;

  const object = info?.object;
  if (!object) {
    if (focusedMmsi.value) clearFocus();
    return;
  }

  const mmsi = object.properties?.mmsi;
  if (mmsi) setFocusMmsi(String(mmsi));
}

function renderDeckLayers() {
  if (!deckOverlay) return;

  if (showRouteHeatmap.value) {
    deckOverlay.setProps({
      layers: [
        new GeoJsonLayer({
          id: 'route-segments',
          data: routeSegments,
          pickable: false,
          stroked: true,
          filled: false,
          lineWidthUnits: 'pixels',
          getLineColor: getRouteHeatColor,
          getLineWidth: getRouteHeatWidth,
          parameters: { depthTest: false }
        })
      ]
    });
    return;
  }

  const lines = decorateCollection(rawData.lines);

  deckOverlay.setProps({
    layers: [
      new GeoJsonLayer({
        id: 'track-lines-glow',
        data: lines,
        stroked: true,
        filled: false,
        lineWidthUnits: 'pixels',
        getLineColor: (feature) => getDeckColor(feature, feature.properties?.isFocused ? 68 : 42),
        getLineWidth: (feature) => (feature.properties?.isFocused ? 8 : 5),
        parameters: { depthTest: false }
      }),
      new GeoJsonLayer({
        id: 'track-lines',
        data: lines,
        pickable: true,
        stroked: true,
        filled: false,
        lineWidthUnits: 'pixels',
        getLineColor: (feature) => getDeckColor(feature, 220),
        getLineWidth: (feature) => (feature.properties?.isFocused ? 3.6 : 2),
        onHover: handleDeckHover,
        onClick: handleDeckClick,
        parameters: { depthTest: false }
      })
    ]
  });
}

function applyRenderedData() {
  renderDeckLayers();
}

function setFocusMmsi(mmsi) {
  focusedMmsi.value = focusedMmsi.value === mmsi ? '' : mmsi;
  applyRenderedData();
}

function clearFocus() {
  focusedMmsi.value = '';
  applyRenderedData();
}

function getMmsiBbox(mmsi) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const feature of rawData.points.features) {
    if (feature.properties?.mmsi !== mmsi) continue;
    const [lon, lat] = feature.geometry.coordinates;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  if (!Number.isFinite(minLon)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

function fitToBbox(bbox) {
  if (!map || !bbox) return;
  map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]]
    ],
    { padding: 64, duration: 650, maxZoom: 13 }
  );
}

function validateTimeWindow() {
  if (!startTime.value || !endTime.value) {
    throw new Error('请选择开始时间和结束时间。');
  }
  if (startTime.value > endTime.value) {
    throw new Error('开始时间不能晚于结束时间。');
  }
}

function currentWindowParams() {
  return new URLSearchParams({
    start: inputToDb(startTime.value),
    end: inputToDb(endTime.value)
  });
}

function addDeckOverlay() {
  if (!map) return;
  deckOverlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(deckOverlay);
}

async function loadBounds() {
  const response = await fetch(apiUrl('/api/time-bounds'));
  if (!response.ok) throw new Error(`时间范围加载失败: ${response.status}`);
  const data = await response.json();
  bounds.value = data;
  startTime.value = dbToInput(data.minTime);
  endTime.value = dbToInput(data.maxTime);
}

async function loadTracks() {
  if (!mapReady.value) return;
  validateTimeWindow();

  const requestId = ++currentRequest;
  loading.value = true;
  error.value = '';

  try {
    const response = await fetch(apiUrl(`/api/tracks?${currentWindowParams().toString()}`));
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `轨迹数据加载失败: ${response.status}`);
    }

    const data = await response.json();
    if (requestId !== currentRequest) return;

    rawData.lines = data.lines || emptyCollection();
    rawData.points = data.points || emptyCollection();
    rawData.labels = data.labels || emptyCollection();
    summary.value = data.summary;

    const stillExists = rawData.labels.features.some(
      (feature) => feature.properties?.mmsi === focusedMmsi.value
    );
    if (focusedMmsi.value && !stillExists) {
      focusedMmsi.value = '';
    }

    applyRenderedData();

    if (!hasAppliedInitialView) {
      fitToBbox(data.summary?.bbox);
      hasAppliedInitialView = true;
    }
  } catch (err) {
    if (requestId === currentRequest) {
      error.value = err.message || String(err);
      rawData.lines = emptyCollection();
      rawData.points = emptyCollection();
      rawData.labels = emptyCollection();
      summary.value = null;
      focusedMmsi.value = '';
      applyRenderedData();
    }
  } finally {
    if (requestId === currentRequest) {
      loading.value = false;
    }
  }
}

async function loadRouteSegments() {
  if (!mapReady.value) return;
  validateTimeWindow();

  const requestId = ++currentRequest;
  loading.value = true;
  error.value = '';

  try {
    const response = await fetch(apiUrl(`/api/route-segments?${currentWindowParams().toString()}`));
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `航线热力数据加载失败: ${response.status}`);
    }

    const data = await response.json();
    if (requestId !== currentRequest) return;

    routeSegments = data.segments || emptyCollection();
    summary.value = data.summary;
    applyRenderedData();
  } catch (err) {
    if (requestId === currentRequest) {
      error.value = err.message || String(err);
      routeSegments = emptyCollection();
      summary.value = null;
      applyRenderedData();
    }
  } finally {
    if (requestId === currentRequest) {
      loading.value = false;
    }
  }
}

async function loadCurrentVisualization() {
  if (showRouteHeatmap.value) {
    await loadRouteSegments();
    return;
  }

  await loadTracks();
}

async function toggleRouteHeatmap() {
  showRouteHeatmap.value = !showRouteHeatmap.value;
  setCanvasCursor('');
  await loadCurrentVisualization();
}

async function searchShips() {
  const keyword = searchQuery.value.trim();
  searchError.value = '';
  searchResults.value = [];
  if (!keyword) return;

  try {
    validateTimeWindow();
  } catch (err) {
    searchError.value = err.message || String(err);
    return;
  }

  const requestId = ++currentSearchRequest;
  searchLoading.value = true;

  try {
    const params = currentWindowParams();
    params.set('q', keyword);
    const response = await fetch(apiUrl(`/api/ships/search?${params.toString()}`));
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `船舶搜索失败: ${response.status}`);
    }

    const data = await response.json();
    if (requestId !== currentSearchRequest) return;
    searchResults.value = data.results || [];
    if (!searchResults.value.length) {
      searchError.value = '当前时间范围内未找到匹配船舶。';
    }
  } catch (err) {
    if (requestId === currentSearchRequest) {
      searchError.value = err.message || String(err);
    }
  } finally {
    if (requestId === currentSearchRequest) {
      searchLoading.value = false;
    }
  }
}

function selectSearchResult(result) {
  const isSame = focusedMmsi.value === result.mmsi;
  focusedMmsi.value = isSame ? '' : result.mmsi;
  applyRenderedData();
  if (!isSame && !showRouteHeatmap.value) {
    const bbox = getMmsiBbox(result.mmsi);
    fitToBbox(bbox);
  }
}

async function applyTimeWindow() {
  await loadCurrentVisualization();
  if (searchQuery.value.trim()) {
    await searchShips();
  } else {
    searchResults.value = [];
    searchError.value = '';
  }
}

onMounted(async () => {
  if (!mapboxToken) {
    error.value = '缺少 VITE_MAPBOX_TOKEN，请在 .env 中配置 Mapbox access token。';
    return;
  }

  mapboxgl.accessToken = mapboxToken;

  map = new mapboxgl.Map({
    container: mapEl.value,
    style: 'mapbox://styles/mapbox/navigation-day-v1',
    center: [118.78, 32.02],
    zoom: 9.6,
    attributionControl: true
  });

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
  map.on('mouseout', () => {
    setCanvasCursor('');
  });

  map.once('load', async () => {
    addDeckOverlay();
    mapReady.value = true;
    await nextTick();

    try {
      await loadBounds();
      await loadCurrentVisualization();
    } catch (err) {
      error.value = err.message || String(err);
    }
  });
});

onBeforeUnmount(() => {
  if (deckOverlay && map) map.removeControl(deckOverlay);
  map?.remove();
});
</script>

<template>
  <main class="app-shell">
    <div ref="mapEl" class="map"></div>

    <section class="control-panel" aria-label="轨迹控制面板">
      <label class="field-label" for="start-time">开始时间</label>
      <input
        id="start-time"
        v-model="startTime"
        class="time-input"
        type="datetime-local"
        step="3600"
      />

      <label class="field-label" for="end-time">结束时间</label>
      <input
        id="end-time"
        v-model="endTime"
        class="time-input"
        type="datetime-local"
        step="3600"
      />

      <button type="button" class="apply-button" @click="applyTimeWindow">应用时间范围</button>

      <div v-if="bounds" class="meta-grid">
        <span>全库起点</span>
        <strong>{{ bounds.minTime }}</strong>
        <span>全库终点</span>
        <strong>{{ bounds.maxTime }}</strong>
      </div>

      <div v-if="timeWindowLabel" class="meta-text">当前时间范围：{{ timeWindowLabel }}</div>

      <div class="search-panel">
        <label class="field-label">显示内容</label>
        <button
          type="button"
          class="toggle-button"
          :class="{ active: showRouteHeatmap }"
          @click="toggleRouteHeatmap"
        >
          航线热力
        </button>

        <label class="field-label" for="ship-search">船舶查询</label>
        <div class="search-row">
          <input
            id="ship-search"
            v-model.trim="searchQuery"
            class="search-input"
            type="text"
            placeholder="输入 MMSI 或船名"
            @keydown.enter.prevent="searchShips"
          />
          <button type="button" class="search-button" @click="searchShips">搜索</button>
        </div>

        <div v-if="focusSummary" class="focus-banner">
          已聚焦 {{ focusSummary }}
          <button type="button" class="text-button" @click="clearFocus">清除</button>
        </div>

        <div v-if="searchLoading" class="meta-text">正在搜索船舶...</div>
        <div v-else-if="searchError" class="error-text">{{ searchError }}</div>

        <ul v-if="searchResults.length" class="search-results">
          <li v-for="result in searchResults" :key="result.mmsi">
            <button
              type="button"
              class="search-result"
              :class="{ active: focusedMmsi === result.mmsi }"
              @click="selectSearchResult(result)"
            >
              <span class="search-result-name">{{ result.shipName }}</span>
              <span class="search-result-meta">{{ result.mmsi }}</span>
              <span class="search-result-meta">{{ formatNumber(result.pointCount) }} 点</span>
            </button>
          </li>
        </ul>
      </div>

      <div v-if="summary && !showRouteHeatmap" class="meta-text">
        当前显示 {{ formatNumber(summary.lines) }} 条轨迹线，{{ formatNumber(summary.rows) }} 个轨迹点
      </div>
      <div v-else-if="summary" class="meta-text">
        当前显示 {{ formatNumber(summary.segments) }} 条热力线段，最大密度 {{ summary.maxDensity?.toFixed?.(2) || '-' }}
      </div>
      <div v-if="loading" class="meta-text">正在加载轨迹数据...</div>
      <div v-if="error" class="error-text">{{ error }}</div>
    </section>
  </main>
</template>
