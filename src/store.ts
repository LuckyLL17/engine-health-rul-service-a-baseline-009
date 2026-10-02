import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { demoEngine, demoMaintenance, demoModels, createDemoTelemetry } from './demo-data.js';
import { Engine, HealthAssessment, MaintenanceEvent, MaintenancePlan, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

type State = { engines: Engine[]; telemetry: TelemetrySample[]; maintenance: MaintenanceEvent[]; models: ModelVersion[]; assessments: HealthAssessment[]; predictions: RulPrediction[]; plans: MaintenancePlan[]; audit: Array<Record<string, unknown>> };

export class LocalStore {
  private state: State = { engines: [demoEngine], telemetry: createDemoTelemetry(), maintenance: demoMaintenance, models: demoModels, assessments: [], predictions: [], plans: [], audit: [] };
  constructor(private readonly file = resolve(process.cwd(), 'data/state.json')) {}
  async init(): Promise<void> { try { const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>; this.state = { ...this.state, ...parsed, plans: parsed.plans ?? [] }; } catch { await this.persist(); } }
  async persist(): Promise<void> { await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(this.state, null, 2)); }
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
