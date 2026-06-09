export enum Color {
  Red,
  Green = 2,
  Blue = "blue"
}

export enum Direction {
  North = 1,
  South
}

export interface Named {
  name: string;
}

export type ScoreEntry = [label: string, value: number];

export class Person implements Named {
  static species = "human";

  constructor(public readonly name: string, private age: number = 0) {}

  get label(): string {
    return `${this.name}:${this.age}`;
  }

  birthday(): Person {
    this.age += 1;
    return this;
  }
}

export function describePerson(person: Person): string {
  return `${person.label}:${Person.species}`;
}

export function totalScores(entries: ScoreEntry[]): number {
  let total: number = 0;
  for (const [, value] of entries) {
    total += value;
  }
  return total;
}

export function choose<T>(first: T, second: T = first): T {
  return second;
}

export const flags = { enabled: true, count: 3 };

export const doubled = [1, 2, 3].map((value) => value * 2);

export async function asyncValue(value: number): Promise<number> {
  return value + 1;
}
