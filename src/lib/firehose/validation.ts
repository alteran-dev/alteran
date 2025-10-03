import { createErrorFrame } from './frames';

export function checkCursor(cursor: number, currentSeq: number): Uint8Array | null {
  if (Number.isFinite(cursor) && Number.isFinite(currentSeq) && cursor > currentSeq) {
    return createErrorFrame('FutureCursor', 'Cursor is ahead of current sequence').toFramedBytes();
  }
  return null;
}

