import { writeSync } from 'node:fs';
process.on('exit', () => writeSync(1, 'drained 0\n'));
