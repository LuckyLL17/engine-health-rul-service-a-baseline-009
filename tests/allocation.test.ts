import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';
import { Component, Engine, HealthAssessment, MaintenancePlanView, RulPrediction } from '../src/types.js';

const engine = (id: string): Engine => ({ id, serialNumber: `SN-${id}`, model: 'AeroCore-X90', aircraftId: 'AC-1', installedAt: '2025-01-01', totalCycles: 1200, status: 'watch', currentHealthScore: 80 });

const assessment = (engineId: string, healthScore: number, createdAt = new Date().toISOString()): HealthAssessment => ({
  assessmentId: `ASSESS-${engineId}-${healthScore}`, engineId, modelVersion: 'health-v2', createdAt, sampleCount: 72,
  healthScore, status: healthScore >= 70 ? 'watch' : 'degraded',
  dataQuality: { score: 95, usableSamples: 70, rejectedSamples: 2, missingIntervals: 0 },
  indicators: { exhaustTemperatureMargin: 40, fuelEfficiencyIndex: 80, vibrationRisk: 20, oilPressureMargin: 1, degradationSlope: .01 },
  componentRisks: [], anomalies: [], explanation: []
});

const prediction = (engineId: string, lowerBound: number, component: Component = 'bearing', createdAt = new Date().toISOString()): RulPrediction => ({
  predictionId: `RUL-${engineId}-${lowerBound}-${component}`, engineId, modelVersion: 'health-v2', createdAt, horizonCycles: 240,
  estimatedRemainingCycles: lowerBound + 40, confidence: 80, lowerBound, upperBound: lowerBound + 90,
  limitingComponent: component, riskByHorizon: [], evidence: []
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'allocation-'));
  const file = join(dir, 'state.json');
  const store = new LocalStore(file);
  const app = await createApp(store);
  store.engines.splice(0); store.telemetry.splice(0); store.maintenance.splice(0);
  return { dir, file, store, app };
}

const postPlan = async (app: Awaited<ReturnType<typeof createApp>>, payload: unknown) => JSON.parse((await app.inject({ method: 'POST', url: '/api/maintenance-plans', payload: payload as Record<string, unknown> })).body) as MaintenancePlanView;
const getPlan = async (app: Awaited<ReturnType<typeof createApp>>, id: string) => JSON.parse((await app.inject({ method: 'GET', url: `/api/maintenance-plans/${id}` })).body) as MaintenancePlanView;

describe('maintenance resource allocation', () => {
  it('allocates limited slots across engines by risk and survives restart', async () => {
    const { file, store, app } = await setup();
    store.addEngine(engine('ENG-A')); store.addAssessment(assessment('ENG-A', 90)); store.addPrediction(prediction('ENG-A', 200));
    store.addEngine(engine('ENG-B')); store.addAssessment(assessment('ENG-B', 60)); store.addPrediction(prediction('ENG-B', 80));
    store.addEngine(engine('ENG-C')); store.addAssessment(assessment('ENG-C', 75)); store.addPrediction(prediction('ENG-C', 120));
    store.addEngine(engine('ENG-D')); store.addAssessment(assessment('ENG-D', 88)); store.addPrediction(prediction('ENG-D', 300));

    const plan = await postPlan(app, { requestId: 'REQ-MULTI', capacity: 2 });
    expect(plan.slots.map(slot => slot.engineId)).toEqual(['ENG-B', 'ENG-C']);
    expect(plan.slots[0].rank).toBe(1);
    expect(plan.slots[0].reasons.length).toBeGreaterThan(2);
    expect(plan.slots[0].assessmentId).toBe('ASSESS-ENG-B-60');
    expect(plan.excluded.filter(item => item.reason === 'capacity_exceeded').map(item => item.engineId).sort()).toEqual(['ENG-A', 'ENG-D']);
    expect(plan.status).toBe('active');
    expect(plan.staleReasons).toEqual([]);

    await app.close();
    const restarted = await createApp(new LocalStore(file));
    const list = JSON.parse((await restarted.inject({ method: 'GET', url: '/api/maintenance-plans' })).body) as MaintenancePlanView[];
    expect(list).toHaveLength(1);
    const reloaded = await getPlan(restarted, plan.id);
    expect(reloaded.slots).toEqual(plan.slots);
    expect(reloaded.excluded).toEqual(plan.excluded);
    await restarted.close();
  });

  it('breaks risk ties deterministically and deduplicates repeated submissions', async () => {
    const { store, app } = await setup();
    store.addEngine(engine('ENG-B')); store.addAssessment(assessment('ENG-B', 70)); store.addPrediction(prediction('ENG-B', 100));
    store.addEngine(engine('ENG-A')); store.addAssessment(assessment('ENG-A', 70)); store.addPrediction(prediction('ENG-A', 100));

    const first = await postPlan(app, { requestId: 'REQ-TIE', capacity: 1 });
    expect(first.slots.map(slot => slot.engineId)).toEqual(['ENG-A']);
    expect(first.excluded).toEqual([expect.objectContaining({ engineId: 'ENG-B', reason: 'capacity_exceeded' })]);

    const second = await postPlan(app, { requestId: 'REQ-TIE', capacity: 1 });
    expect(second.id).toBe(first.id);
    expect(second.slots).toEqual(first.slots);
    expect(store.plans).toHaveLength(1);
    await app.close();
  });

  it('excludes engines with missing, stale or mismatched data and explains why', async () => {
    const { store, app } = await setup();
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.addEngine(engine('ENG-OK')); store.addAssessment(assessment('ENG-OK', 65)); store.addPrediction(prediction('ENG-OK', 90, 'bearing'));
    store.addEngine(engine('ENG-NOPRED')); store.addAssessment(assessment('ENG-NOPRED', 60));
    store.addEngine(engine('ENG-NOASM'));
    store.addEngine(engine('ENG-STALE')); store.addAssessment(assessment('ENG-STALE', 60, old)); store.addPrediction(prediction('ENG-STALE', 90, 'bearing', old));
    store.addEngine(engine('ENG-OUTDATED')); store.addAssessment(assessment('ENG-OUTDATED', 60)); store.addPrediction(prediction('ENG-OUTDATED', 90, 'bearing', earlier));
    store.addEngine(engine('ENG-MISMATCH')); store.addAssessment(assessment('ENG-MISMATCH', 55)); store.addPrediction(prediction('ENG-MISMATCH', 70, 'hot_section'));

    const plan = await postPlan(app, { requestId: 'REQ-EXCLUDE', capacity: 5, components: ['bearing', 'compressor'] });
    expect(plan.slots.map(slot => slot.engineId)).toEqual(['ENG-OK']);
    const excluded = new Map(plan.excluded.map(item => [item.engineId, item.reason]));
    expect(excluded.get('ENG-NOPRED')).toBe('missing_prediction');
    expect(excluded.get('ENG-NOASM')).toBe('missing_assessment');
    expect(excluded.get('ENG-STALE')).toBe('stale_data');
    expect(excluded.get('ENG-OUTDATED')).toBe('stale_data');
    expect(excluded.get('ENG-MISMATCH')).toBe('component_mismatch');
    expect(plan.excluded.every(item => item.detail.length > 0)).toBe(true);
    await app.close();
  });

  it('marks the plan stale after re-assessment or new maintenance', async () => {
    const { store, app } = await setup();
    store.addEngine(engine('ENG-A')); store.addAssessment(assessment('ENG-A', 80)); store.addPrediction(prediction('ENG-A', 100));
    const plan = await postPlan(app, { requestId: 'REQ-STALE', capacity: 1 });
    expect(plan.status).toBe('active');

    store.addMaintenance({ id: 'M-1', engineId: 'ENG-A', component: 'bearing', occurredAt: new Date().toISOString(), action: 'inspection', severity: 'routine', note: '振动复核' });
    await store.persist();
    let view = await getPlan(app, plan.id);
    expect(view.status).toBe('stale');
    expect(view.staleReasons.join()).toContain('维护事件');

    store.addAssessment(assessment('ENG-A', 55));
    await store.persist();
    view = await getPlan(app, plan.id);
    expect(view.status).toBe('stale');
    expect(view.staleReasons.join()).toContain('重新完成健康评估');
    expect(view.slots).toEqual(plan.slots);
    await app.close();
  });

  it('validates capacity and returns 404 for unknown plans', async () => {
    const { app } = await setup();
    const bad = await app.inject({ method: 'POST', url: '/api/maintenance-plans', payload: {} });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/api/maintenance-plans/PLAN-9999' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
