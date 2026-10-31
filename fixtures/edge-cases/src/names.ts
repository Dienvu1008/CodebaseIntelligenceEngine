export namespace Geometry {
  export function area(r: number): number {
    return Math.PI * r * r;
  }
}

export class Registry {
  #entries = new Map<string, number>();
  static #instances = 0;
  'quoted name'(): void {}
  [Symbol.iterator](): IterableIterator<number> {
    return this.#entries.values();
  }
}

export function outer(): () => number {
  function inner(): number {
    function innermost(): number {
      return 3;
    }
    return innermost();
  }
  return inner;
}
