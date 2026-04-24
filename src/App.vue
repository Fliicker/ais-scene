<script setup>
import mapboxgl from 'mapbox-gl';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN || '';

const apiUrl = (path) => `${apiBaseUrl}${path}`;
const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(value || 0);
const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });

const mapEl = ref(null);
const options = ref([]);
const selectedRange = ref('all');
const viewMode = ref('tracks');
const loading = ref(false);
const error = ref('');
const summary = ref(null);
const mapReady = ref(false);
const focusedMmsi = ref('');
const searchQuery = ref('');
const searchResults = ref([]);
const searchLoading = ref(false);
const searchError = ref('');

let map = null;
let popup = null;
let currentRequest = 0;
let currentSearchRequest = 0;
let hasAppliedInitialView = false;

const rawData = {
  lines: emptyCollection(),
  points: emptyCollection(),
  labels: emptyCollection()
};

const viewModes = [
  { value: 'tracks', label: '轨迹' },
  { value: 'heatmap', label: '热力' },
  { value: 'hybrid', label: '叠加' }
];

const selectedOption = computed(() =>
  options.value.find((item) => item.value === selectedRange.value)
);

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
      const mmsi = nextFeature.properties?.mmsi || '';
      nextFeature.properties.isFocused = hasFocus && mmsi === focusedMmsi.value;
      nextFeature.properties.isDimmed = hasFocus && mmsi !== focusedMmsi.value;
      nextFeature.properties.heatWeight = 1;
      return nextFeature;
    })
  };
}

function setSourceData(id, data) {
  const source = map?.getSource(id);
  if (source) source.setData(data || emptyCollection());
}

function setLayerVisibility(id, visible) {
  if (map?.getLayer(id)) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

function applyViewMode() {
  if (!map?.getLayer('track-lines')) return;

  const showTracks = viewMode.value !== 'heatmap';
  const showHeatmap = viewMode.value !== 'tracks';

  setLayerVisibility('track-lines-glow', showTracks);
  setLayerVisibility('track-lines', showTracks);
  setLayerVisibility('track-points', showTracks);
  setLayerVisibility('ship-labels', showTracks);
  setLayerVisibility('track-heatmap', showHeatmap);

  if (map.getLayer('track-heatmap')) {
    map.setPaintProperty('track-heatmap', 'heatmap-opacity', viewMode.value === 'hybrid' ? 0.58 : 0.9);
  }
}

function applyLayerFilters() {
  if (!map?.getLayer('track-points')) return;

  const focusFilter = focusedMmsi.value ? ['==', ['get', 'mmsi'], focusedMmsi.value] : null;
  map.setFilter('track-points', focusFilter);
  if (map.getLayer('track-heatmap')) {
    map.setFilter('track-heatmap', focusFilter);
  }
}

function applyRenderedData() {
  setSourceData('track-lines', decorateCollection(rawData.lines));
  setSourceData('track-points', decorateCollection(rawData.points));
  setSourceData('ship-labels', decorateCollection(rawData.labels));
  applyLayerFilters();
  applyViewMode();
}

function getLinePopupHtml(properties) {
  return `<div class="popup-title">${properties.shipName || properties.mmsi}</div>
    <div class="popup-row">MMSI: ${properties.mmsi}</div>`;
}

function getPointPopupHtml(properties) {
  return `<div class="popup-title">${properties.shipName || properties.mmsi}</div>
    <div class="popup-row">MMSI: ${properties.mmsi}</div>
    <div class="popup-row">时间: ${properties.time || '-'}</div>
    <div class="popup-row">航速: ${properties.speed ?? '-'} 航向: ${properties.heading ?? '-'}</div>`;
}

function canShowPopup(properties) {
  if (viewMode.value === 'heatmap') return false;
  if (!focusedMmsi.value) return true;
  return properties?.mmsi === focusedMmsi.value;
}

function updatePopup(event, html) {
  const coordinates = event.lngLat?.toArray?.() || event.features?.[0]?.geometry?.coordinates?.slice?.() || [];
  if (!coordinates.length) return;
  popup.setLngLat(coordinates).setHTML(html).addTo(map);
}

function getPreferredFeature(point) {
  if (!map || viewMode.value === 'heatmap') return null;

  const pointFeature = map.queryRenderedFeatures(point, {
    layers: ['track-points']
  })[0];
  if (pointFeature && canShowPopup(pointFeature.properties)) {
    return { type: 'point', feature: pointFeature };
  }

  const lineFeature = map.queryRenderedFeatures(point, {
    layers: ['track-lines']
  })[0];
  if (lineFeature && canShowPopup(lineFeature.properties)) {
    return { type: 'line', feature: lineFeature };
  }

  return null;
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

function setViewMode(nextMode) {
  viewMode.value = nextMode;
  applyViewMode();
  popup?.remove();
  if (map) {
    map.getCanvas().style.cursor = '';
  }
}

function addMapLayers() {
  if (!map) return;

  map.addSource('track-lines', { type: 'geojson', data: emptyCollection() });
  map.addSource('track-points', { type: 'geojson', data: emptyCollection() });
  map.addSource('ship-labels', { type: 'geojson', data: emptyCollection() });

  map.addLayer({
    id: 'track-lines-glow',
    type: 'line',
    source: 'track-lines',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['case', ['get', 'isFocused'], 8, 5],
      'line-opacity': ['case', ['get', 'isDimmed'], 0.025, ['get', 'isFocused'], 0.24, 0.18]
    }
  });

  map.addLayer({
    id: 'track-lines',
    type: 'line',
    source: 'track-lines',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['case', ['get', 'isFocused'], 3.4, 2],
      'line-opacity': ['case', ['get', 'isDimmed'], 0.06, ['get', 'isFocused'], 0.96, 0.82]
    }
  });

  map.addLayer({
    id: 'track-points',
    type: 'circle',
    source: 'track-points',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.2, 14, 4.6],
      'circle-color': ['get', 'color'],
      'circle-opacity': ['case', ['get', 'isFocused'], 0.94, 0.88],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['case', ['get', 'isFocused'], 1.2, 0.8]
    }
  });

  map.addLayer({
    id: 'track-heatmap',
    type: 'heatmap',
    source: 'track-points',
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 10, 0.9, 16, 1],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.65, 8, 0.9, 13, 1.15],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 4, 8, 10, 12, 16, 15, 22],
      'heatmap-opacity': 0.58,
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0,
        'rgba(45, 117, 229, 0)',
        0.2,
        'rgba(54, 153, 255, 0.22)',
        0.45,
        'rgba(68, 201, 156, 0.32)',
        0.68,
        'rgba(255, 206, 84, 0.42)',
        0.84,
        'rgba(255, 128, 0, 0.52)',
        0.94,
        'rgba(220, 45, 45, 0.68)',
        1,
        'rgba(180, 20, 20, 0.78)'
      ]
    }
  });

  map.addLayer({
    id: 'ship-labels',
    type: 'symbol',
    source: 'ship-labels',
    layout: {
      'text-field': ['get', 'shipName'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 13, 13],
      'text-offset': [0.8, 0.2],
      'text-anchor': 'left',
      'text-allow-overlap': false
    },
    paint: {
      'text-color': '#101827',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.4,
      'text-opacity': ['case', ['get', 'isDimmed'], 0.1, 1]
    }
  });

  applyViewMode();

  map.on('mousemove', (event) => {
    const hit = getPreferredFeature(event.point);
    if (!hit) {
      map.getCanvas().style.cursor = '';
      popup?.remove();
      return;
    }

    map.getCanvas().style.cursor = 'pointer';
    if (hit.type === 'point') {
      updatePopup(event, getPointPopupHtml(hit.feature.properties));
      return;
    }

    updatePopup(event, getLinePopupHtml(hit.feature.properties));
  });

  map.on('mouseout', () => {
    map.getCanvas().style.cursor = '';
    popup?.remove();
  });

  map.on('click', (event) => {
    const hit = getPreferredFeature(event.point);
    if (!hit) {
      if (focusedMmsi.value) clearFocus();
      return;
    }

    const mmsi = hit.feature?.properties?.mmsi;
    if (mmsi) setFocusMmsi(mmsi);
  });
}

async function loadOptions() {
  const response = await fetch(apiUrl('/api/time-options'));
  if (!response.ok) throw new Error(`时间选项加载失败: ${response.status}`);

  const data = await response.json();
  options.value = data.options || [];
  selectedRange.value = data.defaultValue || options.value[0]?.value || 'all';
}

async function loadTracks() {
  if (!mapReady.value) return;

  const requestId = ++currentRequest;
  loading.value = true;
  error.value = '';

  try {
    const response = await fetch(apiUrl(`/api/tracks?range=${encodeURIComponent(selectedRange.value)}`));
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

async function searchShips() {
  const keyword = searchQuery.value.trim();
  searchError.value = '';
  searchResults.value = [];

  if (!keyword) return;

  const requestId = ++currentSearchRequest;
  searchLoading.value = true;

  try {
    const response = await fetch(
      apiUrl(`/api/ships/search?q=${encodeURIComponent(keyword)}&range=${encodeURIComponent(selectedRange.value)}`)
    );
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
  if (!isSame) {
    const bbox = getMmsiBbox(result.mmsi);
    fitToBbox(bbox);
  }
}

async function onRangeChange() {
  await loadTracks();
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
  popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });

  map = new mapboxgl.Map({
    container: mapEl.value,
    style: 'mapbox://styles/mapbox/navigation-day-v1',
    center: [118.78, 32.02],
    zoom: 9.6,
    attributionControl: true
  });

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

  map.once('load', async () => {
    addMapLayers();
    mapReady.value = true;
    await nextTick();

    try {
      await loadOptions();
      await loadTracks();
    } catch (err) {
      error.value = err.message || String(err);
    }
  });
});

onBeforeUnmount(() => {
  popup?.remove();
  map?.remove();
});
</script>

<template>
  <main class="app-shell">
    <div ref="mapEl" class="map"></div>

    <section class="control-panel" aria-label="轨迹控制面板">
      <label class="field-label" for="range-select">时间范围</label>
      <select id="range-select" v-model="selectedRange" class="range-select" @change="onRangeChange">
        <option v-for="item in options" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>

      <div v-if="selectedOption" class="meta-grid">
        <span>轨迹点</span>
        <strong>{{ formatNumber(selectedOption.rows) }}</strong>
        <span>船舶数</span>
        <strong>{{ formatNumber(selectedOption.ships) }}</strong>
      </div>

      <div class="search-panel">
        <label class="field-label">显示模式</label>
        <div class="mode-switch" role="tablist" aria-label="显示模式">
          <button
            v-for="mode in viewModes"
            :key="mode.value"
            type="button"
            class="mode-button"
            :class="{ active: viewMode === mode.value }"
            @click="setViewMode(mode.value)"
          >
            {{ mode.label }}
          </button>
        </div>

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

      <div v-if="summary" class="meta-text">
        当前显示 {{ formatNumber(summary.lines) }} 条轨迹线，{{ formatNumber(summary.rows) }} 个轨迹点
      </div>
      <div v-if="loading" class="meta-text">正在加载轨迹数据...</div>
      <div v-if="error" class="error-text">{{ error }}</div>
    </section>
  </main>
</template>
