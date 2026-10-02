import { Engine, MaintenanceEvent, ModelVersion, TelemetrySample } from './types.js';

export const demoEngine: Engine = {
  id: 'ENG-DEMO-001', serialNumber: 'CFM-DEMO-2026-001', model: 'AeroCore-X90', aircraftId: 'AC-2048', installedAt: '2024-04-12', totalCycles: 1834, status: 'watch', currentHealthScore: 82
};

export const demoModels: ModelVersion[] = [
  { id: 'health-v1', label: '规则基线模型', weights: { temperature: .28, fuel: .17, vibration: .25, oil: .15, degradation: .15 }, calibratedAt: '2026-09-01' },
  { id: 'health-v2', label: '工况归一化模型', weights: { temperature: .25, fuel: .18, vibration: .27, oil: .12, degradation: .18 }, calibratedAt: '2026-09-20' }
];

export const demoMaintenance: MaintenanceEvent[] = [
  { id: 'M-001', engineId: demoEngine.id, component: 'bearing', occurredAt: '2026-05-11', action: 'inspection', severity: 'routine', note: '轴承振动趋势检查，未发现裂纹证据' },
  { id: 'M-002', engineId: demoEngine.id, component: 'lubrication', occurredAt: '2026-06-28', action: 'calibration', severity: 'important', note: '滑油压力传感器完成校准' }
];

export function createDemoTelemetry(engineId = demoEngine.id): TelemetrySample[] {
  const rows: TelemetrySample[] = [];
  const phases = ['taxi', 'takeoff', 'climb', 'cruise', 'descent', 'landing'] as const;
  for (let i = 0; i < 72; i += 1) {
    const phase = phases[Math.floor(i / 12)];
    const drift = i * .055;
    const phaseBoost = phase === 'takeoff' ? 42 : phase === 'climb' ? 28 : phase === 'cruise' ? 14 : 0;
    rows.push({
      engineId, flightId: `FLIGHT-${String(310 + Math.floor(i / 12)).padStart(4, '0')}`,
      timestamp: new Date(Date.UTC(2026, 8, 30, 8, i * 10)).toISOString(), cycle: 1763 + i,
      phase, rpm: 7200 + phaseBoost * 5 + Math.sin(i / 3) * 35,
      exhaustGasTemp: 612 + phaseBoost + drift + Math.sin(i / 4) * 5 + (i === 59 ? 75 : 0),
      fuelFlow: 238 + phaseBoost * .7 + drift * .4 + Math.cos(i / 5) * 3,
      vibration: 1.2 + i * .012 + Math.sin(i / 4) * .08 + (i === 48 ? .9 : 0),
      oilPressure: 4.6 - i * .006 + Math.cos(i / 5) * .05, oilTemperature: 86 + phaseBoost * .1 + i * .03,
      ambientTemperature: 18 - i * .02, altitude: phase === 'cruise' ? 9800 : phase === 'climb' ? 5600 : 800,
      thrust: 32 + phaseBoost * .35 + Math.sin(i / 6) * 1.5
    });
  }
  return rows;
}
