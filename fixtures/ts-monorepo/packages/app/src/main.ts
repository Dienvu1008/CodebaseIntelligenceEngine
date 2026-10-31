import { Counter } from '@demo/core';
import { add, PI } from '@demo/core/math';
import { settings } from '~/config.js';
import path from 'node:path';
import chalk from 'chalk';
import { missing } from '@demo/core/internal';

export function run(): string {
  const c = new Counter();
  c.increment(add(1, 2));
  return chalk.green(path.join(String(PI), String(settings.verbose), String(missing)));
}
