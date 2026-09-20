# Clash Traffic

Clash Verge 本地流量采集与实时 Web 仪表盘。

## 功能

- 持续采集 Clash Verge 流量信息并写入本地 SQLite。
- 按进程、域名、出站节点和规则聚合流量。
- 提供本地 Web 仪表盘，支持时间范围、排行和趋势查看。
- 支持旧版 JSONL 数据增量导入。
- 仅监听 `127.0.0.1`，运行数据保存在本机 `data/` 目录。

## 环境要求

- Node.js 22.5 或更高版本。
- Windows 下可直接使用仓库里的 `启动.vbs` / `停止.cmd`。

项目运行时使用 Node 内置的 `node:sqlite`，没有运行时 npm 依赖。

## 启动

```powershell
npm start
```

默认会启动采集器并打开：

```text
http://127.0.0.1:18900/
```

也可以双击 `启动.vbs`。重复启动时，程序会检测已有实例并避免重复采集。

可选环境变量：

- `CLASH_TRAFFIC_PORT`：修改本地服务端口，默认 `18900`。
- `CLASH_TRAFFIC_INTERVAL`：修改采样间隔（毫秒），默认 `5000`。

## 停止

双击 `停止.cmd`，或运行：

```powershell
node scripts/stop.js
```

## 测试

```powershell
npm test
```

## 历史数据导入

旧版采集器留下的 JSONL 文件可以放到 `data/` 后执行：

```powershell
npm run import-legacy
```

导入进度记录在 SQLite 的 `meta` 表中，重复运行只会补入新增行。

## 数据与隐私

运行数据、SQLite 数据库、WAL 文件、日志和旧版 JSONL 都位于 `data/`，该目录已通过 `.gitignore` 排除，不进入 Git。

服务只绑定 `127.0.0.1`，默认不会向局域网或公网开放。

## 第三方文件

`web/vendor/echarts.min.js` 为本地托管的 ECharts 前端依赖，用于避免运行时依赖 CDN。