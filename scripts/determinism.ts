export interface DeterministicClock {
  now(): string;
}

export function createDeterministicClock(instant: string): DeterministicClock {
  return {
    now: () => instant,
  };
}

export function createDeterministicIdFactory(namespace: string): () => string {
  let sequence = 0;

  return () => {
    sequence += 1;
    return `${namespace}-${sequence.toString().padStart(4, "0")}`;
  };
}
