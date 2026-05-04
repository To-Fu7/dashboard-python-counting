import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function captureFrame(rtspUrl: string): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `frame_${Date.now()}.jpg`);
  const isLocalDevice = /^(\d+|\/dev\/)/.test(rtspUrl);

  const args = [
    '-y',
    ...(!isLocalDevice ? ['-rtsp_transport', 'tcp'] : []),
    '-i', rtspUrl,
    '-frames:v', '1',
    '-q:v', '2',
    tmpFile,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    function cleanup() {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    }

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      cleanup();
      reject(new Error('Capture timed out after 15s'));
    }, 15000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!fs.existsSync(tmpFile)) {
        cleanup();
        reject(new Error(`ffmpeg exited ${code} without output. ${stderr.slice(-400)}`));
        return;
      }
      const buf = fs.readFileSync(tmpFile);
      cleanup();
      resolve(buf);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });
}
