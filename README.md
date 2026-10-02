# 航空发动机健康状态评估与剩余寿命预测服务

这是一个可直接在主机运行的纯后端 Node.js + TypeScript 项目，不依赖 Docker、数据库、Redis、Kafka 或云服务。业务状态默认写入本地 `data/state.json`，演示数据由代码生成，适合离线测试和后续接入真实传感器数据。

## 已实现业务

- 发动机档案与型号配置
- 飞行架次和多传感器时序导入
- 时间戳、单位、范围和单调性校验
- 缺失值线性插值与异常点剔除
- 飞行阶段工况归一化
- 排气温度裕度、燃油效率、振动风险、滑油压力裕度计算
- 传感器漂移和突变检测
- 发动机健康评分与状态分级
- 部件级风险排序
- 基于退化趋势的剩余寿命估算
- 预测置信区间与解释性证据
- 维修事件回灌和风险修正
- 传感器数据按时间顺序重放
- 维护窗口推演
- 模型版本比较
- 告警事件、审计轨迹和本地结果导出
- 维护资源分配：跨发动机按风险、寿命下界、部件匹配和名额约束生成可追溯排程方案，支持幂等提交与过期识别

## 运行

```bash
npm install
npm run build
npm test
npm run demo
npm start
```

服务默认监听 `http://127.0.0.1:6195`。

## 主要 API

```text
GET  /api/health
GET  /api/models
POST /api/engines/import
GET  /api/engines/:id
GET  /api/engines/:id/telemetry
POST /api/engines/:id/health-assessment
POST /api/engines/:id/rul-prediction
POST /api/engines/:id/replay
GET  /api/replay/jobs/:id
POST /api/engines/:id/maintenance-simulation
POST /api/models/compare
GET  /api/engines/:id/risk-events
GET  /api/audit/:engineId
POST /api/maintenance-plans
GET  /api/maintenance-plans
GET  /api/maintenance-plans/:id
```

`POST /api/maintenance-plans` 请求体：`capacity`（名额，必填）、`requestId`（幂等键，重复提交返回原方案）、`components`（本次可检修部件，缺省为全部）、`maxDataAgeDays`（评估/预测有效期，默认 30 天）、`createdBy`。响应中 `slots` 为入选排程（含排序理由与评估/预测溯源），`excluded` 列出缺少评估、缺少预测、数据过期、部件不匹配或名额不足的发动机；`status` 在发动机重新评估、重新预测或新增维护事件后自动变为 `stale` 并给出原因。

## 示例

```bash
curl http://127.0.0.1:6195/api/health
curl http://127.0.0.1:6195/api/engines/ENG-DEMO-001/health-assessment
curl -X POST http://127.0.0.1:6195/api/engines/ENG-DEMO-001/rul-prediction \
  -H 'content-type: application/json' \
  -d '{"horizonCycles":120}'
```
