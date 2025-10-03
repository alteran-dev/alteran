import * as dagCbor from '@ipld/dag-cbor';
import * as uint8arrays from 'uint8arrays';
import { CID } from 'multiformats/cid';

/**
 * Frame types for AT Protocol firehose
 */
export enum FrameType {
  Message = 1,
  Error = -1,
}

/**
 * Frame header structure
 */
export interface FrameHeader {
  op: FrameType;
  t?: string; // Message type discriminator
}

/**
 * Error frame body
 */
export interface ErrorFrameBody {
  error: string;
  message?: string;
}

/**
 * Base frame class
 */
export abstract class Frame {
  abstract header: FrameHeader;
  abstract body: unknown;

  get op(): FrameType {
    return this.header.op;
  }

  /**
   * Encode frame to bytes (header + body as CBOR)
   */
  toBytes(): Uint8Array {
    const headerBytes = dagCbor.encode(this.header);
    const bodyBytes = dagCbor.encode(this.body);
    return uint8arrays.concat([headerBytes, bodyBytes]);
  }

  /**
   * Encode with 4-byte big-endian length prefix (payload = header||body encoded as dag-cbor)
   */
  toFramedBytes(): Uint8Array {
    const payload = this.toBytes();
    const prefix = new Uint8Array(4);
    const len = payload.byteLength >>> 0;
    prefix[0] = (len >>> 24) & 0xff;
    prefix[1] = (len >>> 16) & 0xff;
    prefix[2] = (len >>> 8) & 0xff;
    prefix[3] = len & 0xff;
    return uint8arrays.concat([prefix, payload]);
  }

  isMessage(): this is MessageFrame {
    return this.op === FrameType.Message;
  }

  isError(): this is ErrorFrame {
    return this.op === FrameType.Error;
  }
}

/**
 * Message frame for firehose events
 */
export class MessageFrame<T = unknown> extends Frame {
  header: FrameHeader;
  body: T;

  constructor(body: T, type?: string) {
    super();
    this.header = type ? { op: FrameType.Message, t: type } : { op: FrameType.Message };
    this.body = body;
  }

  get type(): string | undefined {
    return this.header.t;
  }
}

/**
 * Error frame
 */
export class ErrorFrame extends Frame {
  header: FrameHeader;
  body: ErrorFrameBody;

  constructor(error: string, message?: string) {
    super();
    this.header = { op: FrameType.Error };
    this.body = { error, message };
  }

  get code(): string {
    return this.body.error;
  }

  get message(): string | undefined {
    return this.body.message;
  }
}

/**
 * Firehose message types
 */

export interface InfoMessage {
  name: string;
  message?: string;
}

export interface RepoOp {
  action: 'create' | 'update' | 'delete';
  path: string;
  cid: CID | null;
  prev?: CID;
}

export interface CommitMessage {
  seq: number;
  rebase: boolean;
  tooBig: boolean;
  repo: string; // DID
  commit: CID;
  prev: CID | null;
  rev: string; // TID
  since: string | null; // Previous TID
  blocks: Uint8Array; // CAR bytes
  ops: RepoOp[];
  blobs: CID[];
  time: string; // ISO 8601
  prevData?: CID; // Previous MST root
}

export interface IdentityMessage {
  seq: number;
  did: string;
  time: string;
  handle?: string;
}

export interface AccountMessage {
  seq: number;
  did: string;
  time: string;
  active: boolean;
  status?: string;
}

export interface SyncMessage {
  seq: number;
  did: string;
  time: string;
  active: boolean;
  status?: string;
}

/**
 * Create an #info frame
 */
export function createInfoFrame(name: string, message?: string): MessageFrame<InfoMessage> {
  return new MessageFrame({ name, message }, '#info');
}

/**
 * Create a #commit frame
 */
export function createCommitFrame(data: CommitMessage): MessageFrame<CommitMessage> {
  return new MessageFrame(data, '#commit');
}

/**
 * Create an #identity frame
 */
export function createIdentityFrame(data: IdentityMessage): MessageFrame<IdentityMessage> {
  return new MessageFrame(data, '#identity');
}

/**
 * Create an #account frame
 */
export function createAccountFrame(data: AccountMessage): MessageFrame<AccountMessage> {
  return new MessageFrame(data, '#account');
}

/**
 * Create a #sync frame (alias/compat for account-status changes)
 */
export function createSyncFrame(data: SyncMessage): MessageFrame<SyncMessage> {
  return new MessageFrame(data, '#sync');
}

/**
 * Create an error frame
 */
export function createErrorFrame(error: string, message?: string): ErrorFrame {
  return new ErrorFrame(error, message);
}

// Binary encoders (with 4-byte length prefix)
export function encodeInfoFrame(name: string, message?: string): Uint8Array {
  return createInfoFrame(name, message).toFramedBytes();
}

export function encodeCommitFrame(data: CommitMessage): Uint8Array {
  return createCommitFrame(data).toFramedBytes();
}

export function encodeIdentityFrame(data: IdentityMessage): Uint8Array {
  return createIdentityFrame(data).toFramedBytes();
}

export function encodeAccountFrame(data: AccountMessage): Uint8Array {
  return createAccountFrame(data).toFramedBytes();
}

// Alias for TODO nomenclature (#sync)
export function encodeSyncFrame(data: SyncMessage): Uint8Array {
  return createSyncFrame(data).toFramedBytes();
}
