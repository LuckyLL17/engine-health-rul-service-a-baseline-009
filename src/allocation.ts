import { Component, Engine, HealthAssessment, MaintenanceEvent, MaintenancePlan, MaintenancePlanExclusion, MaintenancePlanSlot, RulPrediction } from './types.js';

const allComponents: Component[] = ['hot_section', 'compressor', 'bearing', 'lubrication'];
const dayMs = 24 * 60 * 60 * 1000;
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

// 历史数据可能乱序落盘（如旧状态文件、批量导入），不能依赖数组首项，统一按 createdAt 选择最新一条
export function latestByCreatedAt<T extends { createdAt: string }>(items: T[]): T | undefined {
  let latest: T | undefined;
  let latestTime = -Infinity;
  for (const item of items) {
    const time = Date.parse(item.createdAt);
    if (Number.isFinite(time) && time > latestTime) { latest = item; latestTime = time; }
  }
  return latest;
}

const latestForEngine = <T extends { engineId: string; createdAt: string }>(items: T[], engineId: string): T | undefined =>
  latestByCreatedAt(items.filter(item => item.engineId === engineId));

export type AllocationInput = {
  engines: Engine[];
  assessments: HealthAssessment[];
  predictions: RulPrediction[];
  maintenance: MaintenanceEvent[];
};

type FingerprintEntry = { engineId: string; assessmentId: string | null; predictionId: string | null; maintenanceCount: number };

// 对机队最新评估、预测和维护数量生成指纹，用于识别方案过期
export function fleetFingerprint(input: AllocationInput): string {
  const entries: FingerprintEntry[] = input.engines.map(engine => {
    const assessment = latestForEngine(input.assessments, engine.id);
    const prediction = latestForEngine(input.predictions, engine.id);
    return { engineId: engine.id, assessmentId: assessment?.assessmentId ?? null, predictionId: prediction?.predictionId ?? null, maintenanceCount: input.maintenance.filter(item => item.engineId === engine.id).length };
  }).sort((a, b) => a.engineId.localeCompare(b.engineId));
  return JSON.stringify(entries);
}

export function fingerprintDiff(previous: string, current: string): string[] {
  if (previous === current) return [];
  const parse = (raw: string) => new Map((JSON.parse(raw) as FingerprintEntry[]).map(item => [item.engineId, item]));
  const before = parse(previous); const after = parse(current);
  const reasons: string[] = [];
  for (const [engineId, now] of after) {
    const old = before.get(engineId);
    if (!old) { reasons.push(`发动机 ${engineId} 是方案生成后新加入的`); continue; }
    if (old.assessmentId !== now.assessmentId) reasons.push(`发动机 ${engineId} 已重新完成健康评估`);
    if (old.predictionId !== now.predictionId) reasons.push(`发动机 ${engineId} 已重新生成寿命预测`);
    if (old.maintenanceCount !== now.maintenanceCount) reasons.push(`发动机 ${engineId} 新增了维护事件`);
  }
  for (const engineId of before.keys()) if (!after.has(engineId)) reasons.push(`发动机 ${engineId} 已从机队中移除`);
  return reasons.length ? reasons : ['方案输入数据已发生变化'];
}

export function buildMaintenancePlan(options: AllocationInput & {
  id: string;
  requestId: string;
  createdBy: string;
  capacity: number;
  components?: Component[];
  maxDataAgeDays?: number;
  now?: Date;
}): MaintenancePlan {
  const components = options.components?.length ? options.components : allComponents;
  const maxDataAgeDays = options.maxDataAgeDays ?? 30;
  const now = (options.now ?? new Date()).getTime();
  const excluded: MaintenancePlanExclusion[] = [];
  type Candidate = { engine: Engine; assessment: HealthAssessment; prediction: RulPrediction; priorityScore: number; urgencyScore: number };
  const candidates: Candidate[] = [];
  for (const engine of [...options.engines].sort((a, b) => a.id.localeCompare(b.id))) {
    const assessment = latestForEngine(options.assessments, engine.id);
    if (!assessment) { excluded.push({ engineId: engine.id, reason: 'missing_assessment', detail: '尚未生成健康评估，无法参与维护资源分配' }); continue; }
    const prediction = latestForEngine(options.predictions, engine.id);
    if (!prediction) { excluded.push({ engineId: engine.id, reason: 'missing_prediction', detail: '缺少剩余寿命预测，无法确定维护窗口与寿命下界' }); continue; }
    const assessmentAge = (now - Date.parse(assessment.createdAt)) / dayMs;
    const predictionAge = (now - Date.parse(prediction.createdAt)) / dayMs;
    if (assessmentAge > maxDataAgeDays || predictionAge > maxDataAgeDays) { excluded.push({ engineId: engine.id, reason: 'stale_data', detail: `评估已 ${round(assessmentAge, 1)} 天、预测已 ${round(predictionAge, 1)} 天未更新，超过 ${maxDataAgeDays} 天有效期` }); continue; }
    if (Date.parse(prediction.createdAt) < Date.parse(assessment.createdAt)) { excluded.push({ engineId: engine.id, reason: 'stale_data', detail: '最新健康评估之后尚未重新生成寿命预测，预测已过期' }); continue; }
    if (!components.includes(prediction.limitingComponent)) { excluded.push({ engineId: engine.id, reason: 'component_mismatch', detail: `限制部件 ${prediction.limitingComponent} 不在本次检修能力范围（${components.join('/')}）` }); continue; }
    const urgencyScore = round((100 * 50) / (prediction.lowerBound + 50));
    const priorityScore = round((100 - assessment.healthScore) * .7 + urgencyScore * .3);
    candidates.push({ engine, assessment, prediction, priorityScore, urgencyScore });
  }
  candidates.sort((a, b) => b.priorityScore - a.priorityScore || a.assessment.healthScore - b.assessment.healthScore || a.prediction.lowerBound - b.prediction.lowerBound || a.engine.id.localeCompare(b.engine.id));
  const slots: MaintenancePlanSlot[] = candidates.slice(0, options.capacity).map((candidate, index) => ({
    rank: index + 1,
    engineId: candidate.engine.id,
    healthScore: candidate.assessment.healthScore,
    status: candidate.assessment.status,
    lowerBound: candidate.prediction.lowerBound,
    estimatedRemainingCycles: candidate.prediction.estimatedRemainingCycles,
    limitingComponent: candidate.prediction.limitingComponent,
    matchedComponent: candidate.prediction.limitingComponent,
    assessmentId: candidate.assessment.assessmentId,
    predictionId: candidate.prediction.predictionId,
    priorityScore: candidate.priorityScore,
    reasons: [
      `健康评分 ${candidate.assessment.healthScore}（${candidate.assessment.status}），风险越高优先级越高`,
      `寿命下界 ${candidate.prediction.lowerBound} 循环，紧迫度得分 ${candidate.urgencyScore}`,
      `限制部件 ${candidate.prediction.limitingComponent} 与本次检修能力匹配`,
      `依据评估 ${candidate.assessment.assessmentId} 与预测 ${candidate.prediction.predictionId} 生成`
    ]
  }));
  for (const candidate of candidates.slice(options.capacity)) excluded.push({ engineId: candidate.engine.id, reason: 'capacity_exceeded', detail: `优先级得分 ${candidate.priorityScore} 未进入前 ${options.capacity} 名，转入下一批名额` });
  return {
    id: options.id,
    requestId: options.requestId,
    createdAt: new Date(now).toISOString(),
    createdBy: options.createdBy,
    capacity: options.capacity,
    components,
    maxDataAgeDays,
    slots,
    excluded,
    inputFingerprint: fleetFingerprint(options),
    explanation: [
      `共评估 ${options.engines.length} 台发动机，名额 ${options.capacity} 个，入选 ${slots.length} 台，排除 ${excluded.length} 台`,
      '排序规则：优先级得分 = 健康风险 × 0.7 + 寿命下界紧迫度 × 0.3，同分依次比较健康评分、寿命下界、发动机编号',
      `检修能力部件：${components.join('/')}；评估与预测数据有效期 ${maxDataAgeDays} 天`
    ]
  };
}
