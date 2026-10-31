import { add } from './math.js';

export class Counter {
  #value = 0;

  increment(by = 1): number {
    this.#value = add(this.#value, by);
    return this.#value;
  }
}

export { add };
