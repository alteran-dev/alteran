import { createInfoEvent, encodeEvent } from './frames';

export function checkCursor(cursor: number, currentSeq: number): Uint8Array | null {
  if (Number.isFinite(cursor) && Number.isFinite(currentSeq) && cursor > currentSeq) {
    const info = createInfoEvent('OutdatedCursor', 'Cursor is ahead of current sequence');
    return encodeEvent(info);
  }
  return null;
}
