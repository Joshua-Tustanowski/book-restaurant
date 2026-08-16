import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');

function currentLogPath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${date}.log`);
}

function writeLine(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(' ')}\n`;

  process[level === 'ERROR' ? 'stderr' : 'stdout'].write(line);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(currentLogPath(), line);
}

export const log = {
  info: (...args) => writeLine('INFO', args),
  error: (...args) => writeLine('ERROR', args),
};
