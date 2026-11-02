export interface Shape {
  area(): number;
}

export abstract class Base implements Shape {
  abstract area(): number;

  describe(): string {
    return `area ${this.area()}`;
  }
}

export class Square extends Base {
  constructor(private readonly side: number) {
    super();
  }

  area(): number {
    return this.side * this.side;
  }
}

export function total(shapes: Shape[]): number {
  const total = shapes.reduce((sum, s) => sum + s.area(), 0);
  return total;
}
