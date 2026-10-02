import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { demoEngine, demoMaintenance, demoModels, createDemoTelemetry } from './demo-data.js';
import { Engine, HealthAssessment, MaintenanceEvent, MaintenancePlan, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

type State = { engines: Engine[]; telemetry: TelemetrySample[]; maintenance: MaintenanceEvent[]; models: ModelVersion[]; assessments: HealthAssessment[]; predictions: RulPrediction[]; plans: MaintenancePlan[]; audit: Array<Record<string, unknown>> };

export class LocalStore {
  private state: State = { engines: [demoEngine], telemetry: createDemoTelemetry(), maintenance: demoMaintenance, models: demoModels, assessments: [], predictions: [], plans: [], audit: [] };
  // 串行写队列：并发请求同时改状态时，写入必须排队，避免后写的快照覆盖先写的内容
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly file = resolve(process.cwd(), 'data/state.json')) {}
  async init(): Promise<void> { try { const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>; this.state = { ...this.state, ...parsed, plans: parsed.plans ?? [] }; } catch { await this.persist(); } }
  async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const previous = this.writeChain;
    const write = (async () => {
      // 等待队首写入完成（即使失败也放行），保证并发 persist 严格串行落盘
      await previous.catch(() => undefined);
      await mkdir(dirname(this.file), { recursive: true });
      // 先写同目录临时文件再原子改名，写一半崩溃也不会损坏既有状态文件
      const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await writeFile(tmp, snapshot);
        await rename(tmp, this.file);
      } finally {
        // rename 成功后临时文件已不存在；失败时尽力清理残留临时文件
        await rm(tmp, { force: true });
      }
    })();
    this.writeChain = write;
    await write;
  }
  get engines() { return this.state.engines; }
  get telemetry() { return this.state.telemetry; }
  get maintenance() { return this.state.maintenance; }
  get models() { return this.state.models; }
  get assessments() { return this.state.assessments; }
  get predictions() { return this.state.predictions; }
  get plans() { return this.state.plans; }
  get audit() { return this.state.audit; }
  addTelemetry(rows: TelemetrySample[]) { this.state.telemetry.push(...rows); }
  addEngine(engine: Engine) { this.state.engines.push(engine); }
  addMaintenance(event: MaintenanceEvent) { this.state.maintenance.push(event); }
  addAssessment(value: HealthAssessment) { this.state.assessments.unshift(value); }
  addPrediction(value: RulPrediction) { this.state.predictions.unshift(value); }
  addPlan(value: MaintenancePlan) { this.state.plans.unshift(value); }
  log(action: string, engineId: string, detail: Record<string, unknown>) { this.state.audit.unshift({ id: `AUD-${this.state.audit.length + 1}`, action, engineId, at: new Date().toISOString(), detail }); }
}
