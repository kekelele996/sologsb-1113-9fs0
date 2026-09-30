# 天文观测计划编排台（gbobsplan）

面向业余天文台与高校天文社团的值班排期人员：把「观测目标—可见窗口—月相—望远镜与终端—备用观测夜」串成一份可执行的观测夜编排表，解决目标亮度与月相冲突、设备被重复占用、阴天临时改期难以追溯的问题。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21813>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | MUI（Material UI 5）+ Emotion |
| 路由 | React Router 6（6 条业务路由 + 404） |
| 状态 | Zustand（targetStore / sessionStore / equipmentStore / nightStore / executionStore） |
| 存储 | IndexedDB（Dexie，库名 `gbobsplan-db`，`schemaVersion` 3，含 v2/v3 迁移） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21813
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # target / session / equipment / night / execution（+ index.ts 统一出口）
│       ├── stores/            # targetStore / sessionStore / equipmentStore / nightStore / executionStore
│       ├── components/common/ # Timeline / StatusChip / ConflictBadge / FieldRow
│       ├── hooks/             # usePersistentStore（Dexie 读写 + Zustand 同步）/ useConflictCheck
│       ├── pages/             # OverviewPage / TargetsPage / SessionsPage / EquipmentPage / ReceiptsPage / ExportPage
│       ├── router/index.tsx   # 路由表
│       └── utils/             # astro.ts（高度角/可见窗口/月相）/ receipt.ts（回执解析整批校验）/ effective.ts / reconcile.ts / export.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 本夜编排总览 | 30 分钟刻度时间轴 + 月相与月出月落条带；冲突与低于高度阈值的目标自动标灰 |
| `/targets` | 观测目标库 | 按类型与优先级筛选、按视星等排序、维护地平高度阈值与曝光参数，并给出本夜可见窗口 |
| `/sessions` | 排程段与冲突 | 冲突检测结果、按时段/望远镜校验，勾选多条批量改期到备用观测夜并填写改期原因 |
| `/equipment` | 设备分配视图 | 行 = 望远镜、列 = 30 分钟时段；占用按现场实际口径重算，冲突格标红，点击可一键跳转到对应排程段 |
| `/receipts` | 执行回执逐段对账 | 值守岗整夜回执整批导入：段号 / 时刻 / 帧数 / 望远镜 / 观测夜逐行校验，任一非法整批不入库且计划基线保持原样；同份回执重导幂等；按批次号查回时段与短拍差额 |
| `/export` | 导出观测清单 | 计划基线（目标、时刻、滤镜、帧数）+ 逐段执行结果（实际时段、实际望远镜、实际帧数与差额、批次号）导出为文本与 CSV，支持打印视图 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbobsplan-db`），表：`targets`、`sessions`、`telescopes`、`instruments`、`nights`、`executionBatches`、`executionRecords`、`meta`。
- `db.version(1)` 声明索引；`db.version(2)` 为排程段增加 `backupNightId` 索引并补齐改期替补夜；`db.version(3)` 新增执行回执批次 / 执行记录两表（计划基线 `sessions` 结构不变，仅刷新 `schemaVersion`）。
- **计划基线与执行结果分离**：`sessions` 始终保存排程岗编排的原时段、原设备、计划帧数，回执导入不会修改；现场实际时段、实际帧数、实际望远镜与实际观测夜写入 `executionRecords`，按 `sessionId` 逐段对账。设备占用图、总览时间轴与冲突检测统一以「实际口径」（`utils/effective.ts`）重算：现场换望远镜或观测夜时，旧占用从原设备 / 原观测夜下线。
- **整批原子入库**：回执先经 `utils/receipt.ts` 逐行校验（段号须命中基线、时刻 `HH:mm` 合法且结束晚于开始、帧数非负整数、望远镜编号与观测夜在台账内、批内段号不重复、未在其它批次记账、批次号未被内容不同的回执占用），任一不过即整批拒收并逐行说明问题；通过后在单个 Dexie 事务内写批次与记录。批次号 + 内容签名（FNV-1a）一致视为同一份回执，重导不生成执行记录。
- 首次打开且表为空时写入示例数据（12 个观测目标、5 个观测夜、4 台望远镜、4 台终端、14 段排程，含 1 处设备冲突与 1 条改期记录，另含 1 批 4 段示例执行回执，覆盖顺延、短拍与现场换望远镜）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

### 回执文本格式

`/receipts` 支持粘贴文本或选择 `.csv/.txt` 文件，首行可用元信息、可带表头（也兼容无表头固定列序，分列支持逗号 / 中文逗号 / 制表符 / 分号 / 多空格）：

```
批次号：RCP-20251012-01
值守：沈知远
备注：夜间 23 点后转多云
段号,实际开始,实际结束,实际帧数,望远镜,实际观测夜,备注
s-09,18:32,19:38,40,T-01,,按计划完成
s-10,19:55,21:30,46,T-02,2025-10-13,后半夜云散 换到备用夜执行 短拍 4 帧
```

「实际观测夜」列可空（空则跟随段号的计划夜）；时间可跨零点（如 `23:10-00:20`）。
