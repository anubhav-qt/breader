import { describe, expect, it } from 'vitest';
import { bucket, monthOf, shortDate, weekdayOf } from './format';

const DAY = 86_400_000;

describe('shortDate', () => {
  it('is nothing for no time at all', () => {
    expect(shortDate(0)).toBe('');
  });

  it('writes a day the way this device writes it short', () => {
    const t = Date.UTC(2026, 10, 7, 12);
    expect(shortDate(t)).toBe(new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
  });
});

describe('weekdayOf and monthOf', () => {
  it('name the day and the month in English', () => {
    // 7 November 2026, midday where the tests run.
    const t = new Date(2026, 10, 7, 12).getTime();
    expect(weekdayOf(t)).toBe('Saturday');
    expect(monthOf(t)).toBe('November');
  });
});

describe('bucket', () => {
  const now = new Date(2026, 10, 20, 12).getTime();

  it('names a day of the last week by its weekday', () => {
    expect(bucket(now - 3 * DAY, now)).toEqual({ label: weekdayOf(now - 3 * DAY), kind: 'weekday' });
  });

  it('names an earlier month of this year by its month', () => {
    const t = new Date(2026, 7, 4, 12).getTime();
    expect(bucket(t, now)).toEqual({ label: 'August', kind: 'month' });
  });

  it('keeps today, yesterday and older years as they were', () => {
    expect(bucket(now, now).kind).toBe('today');
    expect(bucket(now - DAY, now).kind).toBe('yesterday');
    expect(bucket(new Date(2024, 2, 1).getTime(), now)).toEqual({ label: '2024', kind: 'year' });
  });
});
