/**
 * Парсер рядків прогресу прегенератора Chunky з логів сервера.
 *
 * Приклади рядків:
 *   [11:30:44 INFO]: [Chunky] Task running for world. Processed: 13312 chunks (9.37%), ETA: 1:42:33, Rate: 20.9 cps, Current: 34, -61
 *   [Chunky] Task finished for world. Processed: 141866 chunks (100%)
 *   [Chunky] Task stopped for world.
 */

export type ChunkyEvent =
  | {
      kind: 'progress';
      percent: number;
      processedChunks: number;
      etaSeconds: number | null;
      rate: number | null;
    }
  | { kind: 'finished' }
  | { kind: 'stopped' };

// «Processed: 13,312 chunks (9.37%)» — коми у тисячах трапляються, тож допускаємо.
const PROGRESS_RE =
  /\[Chunky\][^\n]*?Processed:\s*([\d,]+)\s*chunks?\s*\(([\d.]+)%\)/i;
const ETA_RE = /ETA:\s*([\d:]+)/i;
const RATE_RE = /Rate:\s*([\d.]+)\s*cps/i;
const FINISHED_RE = /\[Chunky\][^\n]*\b(finished|complete[d]?)\b/i;
const STOPPED_RE = /\[Chunky\][^\n]*\b(stopped|cancell?ed|paused)\b/i;

/** "1:42:33" → 6153 секунди; "12:30" → 750; підтримує і "D:HH:MM:SS". */
export function parseEtaSeconds(raw: string): number | null {
  const parts = raw.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  // Останній сегмент — секунди, далі хвилини, години, дні.
  const multipliers = [1, 60, 3600, 86400];
  let seconds = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const value = parts[parts.length - 1 - i];
    const mult = multipliers[i];
    if (value === undefined || mult === undefined) break;
    seconds += value * mult;
  }
  return seconds;
}

/**
 * Розбирає один рядок логу. Повертає подію Chunky або null, якщо рядок не
 * стосується прегенерації. Порядок перевірок важливий: «finished» містить
 * «Processed … (100%)», тож завершення перевіряємо першим.
 */
export function parseChunkyLine(line: string): ChunkyEvent | null {
  if (!line.includes('[Chunky]')) return null;

  if (FINISHED_RE.test(line)) return { kind: 'finished' };
  if (STOPPED_RE.test(line)) return { kind: 'stopped' };

  const progress = PROGRESS_RE.exec(line);
  if (progress) {
    const processedChunks = Number(progress[1]!.replace(/,/g, ''));
    const percent = Math.min(100, Math.max(0, Number(progress[2])));
    const etaMatch = ETA_RE.exec(line);
    const rateMatch = RATE_RE.exec(line);
    return {
      kind: 'progress',
      percent,
      processedChunks: Number.isFinite(processedChunks) ? processedChunks : 0,
      etaSeconds: etaMatch?.[1] ? parseEtaSeconds(etaMatch[1]) : null,
      rate: rateMatch?.[1] ? Number(rateMatch[1]) : null,
    };
  }

  return null;
}
