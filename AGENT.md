# AGENT.md

## 项目概览

这是一个 AIS 船舶轨迹可视化项目，技术栈为 Vue 3 + Vite + Mapbox GL JS + Node/Express + SQLite。

应用由两部分组成：

- 前端：`src/App.vue`，使用 Mapbox 展示船舶轨迹线、轨迹点、船名注记、热力图、搜索和聚焦交互。
- 后端：`server/index.js`，读取本地 SQLite AIS 数据库，提供 GeoJSON 数据接口给前端。

数据库结构的权威说明在 `docs/数据库结构.md`。涉及数据库字段、表名、时间范围或查询策略时，优先参考该文档。

## 常用命令

```bash
npm run dev
npm run server
npm run build
npm run preview
```

说明：

- `npm run dev` 会同时启动 Express API 服务和 Vite 开发服务。
- Vite 开发端口为 `5177`。
- API 默认端口为 `3001`。
- Vite 已将 `/api` 代理到 `http://localhost:3001`。

## 环境变量

参考 `.env.example`：

```env
AIS_DB_PATH=D:\Projects\ais\data\ais0416.db
API_PORT=3001
VITE_API_BASE_URL=http://localhost:3001
VITE_MAPBOX_TOKEN=your_mapbox_access_token
```

注意：

- `AIS_DB_PATH` 必须指向存在的 SQLite 数据库文件，否则后端启动时会退出。
- `VITE_MAPBOX_TOKEN` 必须配置，前端缺少 token 时不会初始化地图。
- 本项目使用 `node:sqlite` 的 `DatabaseSync`，需要支持该内置模块的较新 Node.js 版本。

## 数据库要点

数据库文件默认位置为 `D:\Projects\ais\data\ais0416.db`，由 1 张船舶信息表和 4 张轨迹表组成：

- `ship`：船舶信息表，主键为 `mmsi`。
- `locus20260413`
- `locus20260414`
- `locus20260415`
- `locus20260416`

轨迹表结构一致，联合主键为 `(mmsi, jssj)`，核心字段包括：

- `mmsi`：船舶 MMSI。
- `jssj`：轨迹点接收时间，格式为 `YYYY-MM-DD HH:MM:SS`。
- `zbjd`：经度。
- `zbwd`：纬度。
- `dqhs`：当前航速。
- `cbhx`：航向。
- `cbcs`：文本存储的吃水或相关状态字段。
- `class_type`：分类编码。

业务关联关系：

```text
ship.mmsi = locusYYYYMMDD.mmsi
```

重要注意事项：

- 轨迹表虽然按日期命名，但部分表包含前一日较晚时间的数据。业务过滤应以 `jssj` 为准，不要只依赖表名日期。
- `jssj` 和 `cjsj` 是 `TEXT` 类型；只要保持 `YYYY-MM-DD HH:MM:SS` 格式，字符串排序等价于时间排序。
- `cbcs`、`cd`、`kd` 等字段看起来像数值，但在库中是文本，做数值计算前要显式转换。
- 当前轨迹表主要只有 `(mmsi, jssj)` 主键索引。全量按时间范围扫描或空间范围查询可能较慢，后续可考虑增加 `jssj`、`zbjd/zbwd` 索引或 SQLite R-Tree。

## 后端结构

主要文件：`server/index.js`

后端启动流程：

1. 从环境变量读取 `AIS_DB_PATH` 和 `API_PORT`。
2. 校验数据库文件存在。
3. 以只读模式打开 SQLite。
4. 自动发现符合 `locusYYYYMMDD` 命名的轨迹表。
5. 将所有轨迹表通过 `UNION ALL` 作为查询来源。
6. 提供 API，并在生产构建后静态托管 `dist`。

现有接口：

- `GET /api/health`
  - 返回服务状态和数据库路径。
- `GET /api/time-bounds`
  - 返回全库轨迹数量、船舶数量、时间范围和经纬度范围。
- `GET /api/tracks?start=...&end=...`
  - 返回指定时间范围内的轨迹 GeoJSON。
  - 响应包含 `lines`、`points`、`labels` 和 `summary`。
- `GET /api/ships/search?q=...&start=...&end=...`
  - 在当前时间窗口内按 MMSI、中文船名 `zwmc`、船名 `cbmc` 搜索船舶。

时间参数格式支持：

- `YYYY-MM-DD HH`
- `YYYY-MM-DD HH:mm`
- `YYYY-MM-DD HH:mm:ss`
- `YYYY-MM-DDTHH`
- `YYYY-MM-DDTHH:mm`
- `YYYY-MM-DDTHH:mm:ss`

内部会规范化为 `YYYY-MM-DD HH:mm:ss`。

## 前端结构

主要文件：

- `src/main.js`：创建 Vue 应用并引入全局样式和 Mapbox 样式。
- `src/App.vue`：当前主要业务逻辑和界面都在这个单文件组件中。
- `src/style.css`：全局布局、控制面板、搜索结果、popup 等样式。

`App.vue` 的主要职责：

- 初始化 Mapbox 地图。
- 加载 `/api/time-bounds` 设置默认时间范围。
- 加载 `/api/tracks` 并渲染 GeoJSON。
- 在地图中维护三类数据源：
  - `track-lines`
  - `track-points`
  - `ship-labels`
- 支持三种显示模式：
  - `tracks`：轨迹线 + 轨迹点 + 船名注记。
  - `heatmap`：热力图。
  - `hybrid`：轨迹与热力图叠加。
- 支持按船舶搜索、聚焦 MMSI、点击地图轨迹切换聚焦。
- 鼠标悬停轨迹点或轨迹线时显示 popup。

## GeoJSON 约定

后端返回的 GeoJSON properties 会被前端样式表达式使用，改动时要保持兼容：

轨迹线 `lines.features[].properties`：

- `mmsi`
- `shipName`
- `color`
- `pointCount`

轨迹点 `points.features[].properties`：

- `mmsi`
- `shipName`
- `time`
- `speed`
- `heading`
- `classType`
- `color`

船名注记 `labels.features[].properties`：

- `mmsi`
- `shipName`
- `color`
- `pointCount`
- `lastTime`

前端会在渲染前额外添加：

- `isFocused`
- `isDimmed`

这些字段用于 Mapbox 图层样式，不应由后端持久化。

## 开发注意事项

- 文件请保持 UTF-8 编码，项目中包含中文界面文案和中文文档。
- 优先保持当前轻量结构；除非功能明显变复杂，否则不要过早拆出大型状态管理或路由。
- 修改数据库查询时，注意 SQL 表名只能来自后端自动发现并校验过的 `locusYYYYMMDD` 表，不要直接拼接用户输入。
- 时间范围校验前后端都有处理，新增接口时也应复用相同的时间格式约定。
- 当前 `/api/tracks` 会把指定时间范围内的点一次性返回。全量数据约 42.5 万轨迹点，前端渲染和网络传输都有压力；新增更大数据集时，应考虑分页、抽稀、按视窗查询、瓦片化或服务端聚合。
- Mapbox 图层添加顺序会影响显示效果，新增图层时注意轨迹线、热力图、点和文字的覆盖关系。
- 前端聚焦逻辑依赖 `mmsi` 字符串一致性，后端返回 MMSI 时应统一转为字符串。

## 验证建议

完成改动后至少运行：

```bash
npm run build
```

涉及后端接口时，可启动服务后检查：

```bash
npm run server
```

然后访问：

```text
http://localhost:3001/api/health
http://localhost:3001/api/time-bounds
```

涉及地图交互或样式时，启动完整开发环境：

```bash
npm run dev
```

然后在浏览器打开 Vite 输出的本地地址，通常是：

```text
http://localhost:5177
```
