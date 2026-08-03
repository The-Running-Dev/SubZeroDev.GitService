import { performance } from 'node:perf_hooks';
import { isoUtcTimestamp, type IsoUtcTimestamp } from '../shared/brands.ts';

export interface Clock {
  now(): IsoUtcTimestamp;
  monotonicMs(): number;
}

function toIsoUtcTimestamp(date: Date): IsoUtcTimestamp {
  const parsed = isoUtcTimestamp(date.toISOString());
  if (!parsed.ok) {
    throw new Error('Date.toISOString() did not produce a valid IsoUtcTimestamp — this is unreachable');
  }
  return parsed.value;
}

export const systemClock: Clock = {
  now(): IsoUtcTimestamp {
    return toIsoUtcTimestamp(new Date());
  },
  monotonicMs(): number {
    return performance.now();
  },
};
