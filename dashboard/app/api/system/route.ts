import { NextResponse } from 'next/server';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';

interface CpuStat { total: number; idle: number }

function readProcStat(): CpuStat {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf-8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal ...
    const idle = parts[3] + (parts[4] ?? 0);
    const total = parts.reduce((s, v) => s + v, 0);
    return { total, idle };
  } catch {
    return { total: 0, idle: 0 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCpuUsage(): Promise<number> {
  const a = readProcStat();
  await sleep(250);
  const b = readProcStat();
  const totalDiff = b.total - a.total;
  const idleDiff = b.idle - a.idle;
  if (totalDiff === 0) return 0;
  return Math.round(100 * (1 - idleDiff / totalDiff));
}

function getRam() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    used: Math.round(used / 1024 / 1024),       // MB
    total: Math.round(total / 1024 / 1024),      // MB
    usedGb: (used / 1024 / 1024 / 1024).toFixed(1),
    totalGb: (total / 1024 / 1024 / 1024).toFixed(1),
    pct: Math.round((used / total) * 100),
  };
}

interface GpuInfo {
  name: string;
  utilization: number;
  memUsed: number;
  memTotal: number;
}

function runNvidiaSmi(): Promise<GpuInfo[] | null> {
  // Try common paths; spawn resolves via PATH if not absolute
  const candidates = ['/usr/bin/nvidia-smi', 'nvidia-smi'];

  function tryBin(bin: string): Promise<GpuInfo[] | null> {
    return new Promise(resolve => {
      let proc;
      try {
        proc = spawn(bin, [
          '--query-gpu=name,utilization.gpu,memory.used,memory.total',
          '--format=csv,noheader,nounits',
        ]);
      } catch {
        resolve(null);
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        resolve(null);
      }, 4000);

      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut || code !== 0) {
          if (stderr) console.error(`[system/gpu] nvidia-smi stderr: ${stderr.trim()}`);
          resolve(null);
          return;
        }
        try {
          const gpus = stdout.trim().split('\n').map(line => {
            const parts = line.split(', ').map(s => s.trim());
            return {
              name: parts[0],
              utilization: parseInt(parts[1]) || 0,
              memUsed: parseInt(parts[2]) || 0,
              memTotal: parseInt(parts[3]) || 0,
            };
          }).filter(g => g.memTotal > 0);
          resolve(gpus.length > 0 ? gpus : null);
        } catch {
          resolve(null);
        }
      });

      proc.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  }

  return tryBin(candidates[0]).then(r => r ?? tryBin(candidates[1]));
}

function getGpuStats(): Promise<GpuInfo[] | null> {
  return runNvidiaSmi();
}

export async function GET() {
  const [cpuPct, ram, gpus] = await Promise.all([
    getCpuUsage(),
    Promise.resolve(getRam()),
    getGpuStats(),
  ]);

  return NextResponse.json({
    cpu: { pct: cpuPct },
    ram,
    gpus,
  });
}
