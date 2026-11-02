import { Square, total, type Shape } from './shapes';
import { readFileSync } from 'node:fs';

const handlers: Record<string, () => void> = {
  run() {
    main();
  },
};

function main(): void {
  const shapes: Shape[] = [new Square(2)];
  console.log(total(shapes));
  readFileSync('x');
}

function dispatch(name: string, table: any): void {
  handlers[name]();
  table.go();
}

main();
dispatch('run', null);
