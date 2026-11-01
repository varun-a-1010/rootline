// Local development: API server (tsx, port 8787) and the Vite dev server (proxying /api).
import { spawn } from 'node:child_process';
const procs = [
  spawn('npx', ['tsx', 'watch', 'src/server/main.ts'], { stdio: 'inherit' }),
  spawn('npx', ['vite', '--config', 'web/vite.config.ts'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
