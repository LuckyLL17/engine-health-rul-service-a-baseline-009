import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalStore } from '../src/store.js';
import { Engine } from '../src/types.js';

// 在 writeFile 中注入延迟并统计并发写数：没有串行队列时，多个 persist 的写入必然交叠
const writeCounters = vi.hoisted(() => ({ current: 0, peak: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(async (path: string | URL, data: string, options?: { flag?: string }) => {
      writeCounters.current += 1;
      writeCounters.peak = Math.max(writeCounters.peak, writeCounters.current);
      await new Promise(resolve => setTimeout(resolve, 5));
      await actual.writeFile(path, data, options);
      writeCounters.current -= 1;
    })
  };
});

const makeEngine = (index: number): Engine => ({ id: `ENG-CONC-${index}`, serialNumber: `SN-${index}`, model: 'AeroCore-X90', aircraftId: 'AC-1', installedAt: '2025-01-01', totalCycles: 100, status: 'watch', currentHealthScore: 80 });

describe('LocalStore persistence', () => {
  it('serialises concurrent writes and atomically replaces the state file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-conc-'));
    const file = join(dir, 'state.json');
    writeCounters.current = 0; writeCounters.peak = 0;

    const store = new LocalStore(file);
    await store.init();
    store.engines.splice(0);

    // 20 个交错的修改 + persist：写入期间不得有任何时刻存在两个并发 writeFile
    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      await new Promise(resolve => setTimeout(resolve, (index * 7) % 15));
      store.addEngine(makeEngine(index));
      await store.persist();
    }));

    expect(writeCounters.peak).toBe(1);

    // 最终文件必须是完整合法的 JSON，且包含全部 20 台发动机
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { engines: Engine[] };
    expect(onDisk.engines).toHaveLength(20);
    expect(new Set(onDisk.engines.map(item => item.id)).size).toBe(20);
    expect((await readdir(dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([]);

    // 重启后数据完整可查询
    const restarted = new LocalStore(file);
    await restarted.init();
    expect(restarted.engines).toHaveLength(20);
    expect(restarted.engines.find(item => item.id === 'ENG-CONC-19')).toBeDefined();
  });

  it('keeps the serial write queue usable after a failed flush', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-fail-'));
    // 让状态文件的父目录路径先以普通文件存在，flush 在 mkdir 阶段必然失败
    const blockedParent = join(dir, 'sub');
    await writeFile(blockedParent, 'not-a-directory');
    const file = join(blockedParent, 'state.json');

    const store = new LocalStore(file);
    await expect(store.persist()).rejects.toBeTruthy();

    // 修复写入路径后，同一队列上的后续 persist 仍能正常落盘（未被首次失败中断）
    await rm(blockedParent, { force: true });
    await mkdir(blockedParent, { recursive: true });
    await expect(store.persist()).resolves.toBeUndefined();

    store.addEngine(makeEngine(1));
    await store.persist();

    const reloaded = new LocalStore(file);
    await reloaded.init();
    expect(reloaded.engines.some(item => item.id === 'ENG-CONC-1')).toBe(true);
    expect((await readdir(blockedParent)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
