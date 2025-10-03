// Types via tsconfig

import type { DurableObjectState, D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { commit_log } from '../db/schema';
import { gt, eq, desc } from 'drizzle-orm';
import {
  createInfoFrame,
  createCommitFrame,
  createIdentityFrame,
  createAccountFrame,
  createErrorFrame,
  type CommitMessage,
  type RepoOp,
} from '../lib/firehose/frames';
import { checkCursor } from '../lib/firehose/validation';
import { CID } from 'multiformats/cid';
import { encodeBlocksForCommit } from '../services/car';
import type { Env } from '../env';

interface Client {
  webSocket: WebSocket;
  id: string;
  cursor: number;
}

interface CommitEvent {
  seq: number;
  did: string;
  commitCid: string;
  rev: string;
  data: string; // JSON-encoded commit data
  sig: string; // base64 signature
  ts: number;
  ops?: RepoOp[];
  blocks?: Uint8Array;
}

interface IdentityEvent {
  seq: number;
  did: string;
  handle?: string;
  ts: number;
}

interface AccountEvent {
  seq: number;
  did: string;
  active: boolean;
  status?: string;
  ts: number;
}

type SequencerEvent = CommitEvent | IdentityEvent | AccountEvent;

/**
 * Sequencer Durable Object
 * Manages the firehose event stream for repository updates
 */
export class Sequencer {
  private readonly state: DurableObjectState;
  private readonly env: Env & { PDS_SEQ_WINDOW?: string };
  private readonly clients = new Map<string, Client>();
  private buffer: CommitEvent[] = [];
  private readonly db: D1Database;
  private maxWindow: number;
  private nextSeq = 1;
  private droppedFrameCount = 0;

  constructor(state: DurableObjectState, env: Env & { PDS_SEQ_WINDOW?: string }) {
    this.state = state;
    this.env = env;
    this.db = env.DB;
    this.maxWindow = parseInt(env.PDS_SEQ_WINDOW || '512', 10);

    // Initialize from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<number>('nextSeq');
      if (stored) {
        this.nextSeq = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle event notifications from PDS
    if (request.method === 'POST') {
      if (url.pathname === '/commit') {
        return this.handleCommitNotification(request);
      } else if (url.pathname === '/identity') {
        return this.handleIdentityNotification(request);
      } else if (url.pathname === '/account') {
        return this.handleAccountNotification(request);
      }
    }

    // Handle WebSocket upgrade for firehose subscription
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    return this.handleWebSocketUpgrade(request, url);
  }

  /**
   * Handle commit notification from PDS
   */
  private async handleCommitNotification(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        did: string;
        commitCid: string;
        rev: string;
        data: string;
        sig: string;
        ops?: RepoOp[];
        blocks?: string; // base64-encoded CAR
      };

      // Helper: base64 to Uint8Array (workers-safe)
      const b64ToBytes = (b64: string): Uint8Array => {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      };

      const event: CommitEvent = {
        seq: this.nextSeq++,
        did: body.did,
        commitCid: body.commitCid,
        rev: body.rev,
        data: body.data,
        sig: body.sig,
        ts: Date.now(),
        ops: body.ops,
        blocks: body.blocks ? b64ToBytes(body.blocks) : undefined,
      };

      // Persist sequence number
      await this.state.storage.put('nextSeq', this.nextSeq);

      // Update commit_log with assigned sequence for this commit (if row exists)
      try {
        const db = drizzle(this.db);
        const res = await db.update(commit_log).set({ seq: event.seq }).where(eq(commit_log.cid, event.commitCid)).run();
        // If the row didn't exist (unexpected), insert a minimal row so replay works
        // Note: drizzle's run() returns a driver-specific result; we just best-effort insert
        if ((res as any)?.success === false) {
          await db.insert(commit_log).values({ seq: event.seq, cid: event.commitCid, rev: event.rev, data: event.data, sig: event.sig, ts: event.ts }).run();
        }
      } catch (e) {
        console.warn('commit_log seq update failed:', e);
      }

      // Add to buffer
      this.appendCommit(event);

      // Broadcast to all connected clients
      await this.broadcastCommit(event);

      return new Response('ok');
    } catch (error) {
      console.error('Failed to handle commit notification:', error);
      return new Response('bad request', { status: 400 });
    }
  }

  /**
   * Handle identity notification from PDS (handle changes)
   */
  private async handleIdentityNotification(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        did: string;
        handle?: string;
      };

      const event: IdentityEvent = {
        seq: this.nextSeq++,
        did: body.did,
        handle: body.handle,
        ts: Date.now(),
      };

      // Persist sequence number
      await this.state.storage.put('nextSeq', this.nextSeq);

      // Broadcast to all connected clients
      await this.broadcastIdentity(event);

      return new Response('ok');
    } catch (error) {
      console.error('Failed to handle identity notification:', error);
      return new Response('bad request', { status: 400 });
    }
  }

  /**
   * Handle account notification from PDS (account status changes)
   */
  private async handleAccountNotification(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        did: string;
        active: boolean;
        status?: string;
      };

      const event: AccountEvent = {
        seq: this.nextSeq++,
        did: body.did,
        active: body.active,
        status: body.status,
        ts: Date.now(),
      };

      // Persist sequence number
      await this.state.storage.put('nextSeq', this.nextSeq);

      // Broadcast to all connected clients
      await this.broadcastAccount(event);

      return new Response('ok');
    } catch (error) {
      console.error('Failed to handle account notification:', error);
      return new Response('bad request', { status: 400 });
    }
  }

  /**
   * Handle WebSocket upgrade for firehose subscription
   */
  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    const ws = server as unknown as WebSocket;

    ws.accept();

    // Parse cursor parameter
    const cursorParam = url.searchParams.get('cursor');
    const cursor = cursorParam ? parseInt(cursorParam, 10) : 0;

    // Validate cursor
    if (cursor > this.nextSeq - 1) {
      // Future cursor error
      const err = checkCursor(cursor, this.nextSeq - 1) ?? createErrorFrame('FutureCursor', 'Cursor is ahead of current sequence').toFramedBytes();
      ws.send(err);
      ws.close(1008, 'FutureCursor');
      return new Response(null, { status: 101, webSocket: client });
    }

    const clientObj: Client = { webSocket: ws, id, cursor };
    this.clients.set(id, clientObj);

    // Send #info frame on connection
    const infoFrame = createInfoFrame('com.atproto.sync.subscribeRepos', 'Connected to PDS firehose');
    try {
      ws.send(infoFrame.toFramedBytes());
    } catch (error) {
      console.error('Failed to send info frame:', error);
    }

    // Set up event handlers
    ws.addEventListener('message', (evt) => {
      try {
        const data = typeof evt.data === 'string' ? evt.data : '';
        if (data === 'ping') {
          ws.send('pong');
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.addEventListener('close', () => {
      this.clients.delete(id);
    });

    ws.addEventListener('error', () => {
      this.clients.delete(id);
    });

    // Replay buffered events if cursor provided
    if (cursor > 0) {
      await this.replayFromCursor(ws, cursor);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Replay events from cursor
   */
  private async replayFromCursor(ws: WebSocket, cursor: number): Promise<void> {
    // First try from buffer
    const bufferedEvents = this.buffer.filter((e) => e.seq > cursor);

    if (bufferedEvents.length > 0) {
      for (const event of bufferedEvents) {
        try {
          const frame = await this.createCommitFrame(event);
          ws.send(frame.toFramedBytes());
        } catch (error) {
          console.error('Failed to send buffered event:', error);
        }
      }
    } else {
      // Fetch from database if not in buffer
      try {
        const db = drizzle(this.db);
        const events = await db
          .select()
          .from(commit_log)
          .where(gt(commit_log.seq, cursor))
          .orderBy(commit_log.seq)
          .limit(100)
          .all();

        for (const event of events) {
          try {
            const commitEvent: CommitEvent = {
              seq: event.seq!,
              did: JSON.parse(event.data).did,
              commitCid: event.cid,
              rev: event.rev,
              data: event.data,
              sig: event.sig,
              ts: event.ts,
            };
            const frame = await this.createCommitFrame(commitEvent);
            ws.send(frame.toFramedBytes());
          } catch (error) {
            console.error('Failed to send database event:', error);
          }
        }
      } catch (error) {
        console.error('Failed to fetch events from database:', error);
      }
    }
  }

  /**
   * Broadcast commit event to all connected clients
   */
  private async broadcastCommit(event: CommitEvent): Promise<void> {
    const frame = await this.createCommitFrame(event);
    const bytes = frame.toFramedBytes();

    const disconnected: string[] = [];

    for (const [id, client] of Array.from(this.clients.entries())) {
      try {
        // Check if client's cursor is caught up
        if (event.seq > client.cursor) {
          client.webSocket.send(bytes);
          client.cursor = event.seq;
        }
      } catch (error) {
        console.error(`Failed to send to client ${id}:`, error);
        disconnected.push(id);
      }
    }

    // Clean up disconnected clients
    for (const id of disconnected) {
      this.clients.delete(id);
    }
  }

  /**
   * Broadcast identity event to all connected clients
   */
  private async broadcastIdentity(event: IdentityEvent): Promise<void> {
    const frame = createIdentityFrame({
      seq: event.seq,
      did: event.did,
      time: new Date(event.ts).toISOString(),
      handle: event.handle,
    });
    const bytes = frame.toFramedBytes();

    const disconnected: string[] = [];

    for (const [id, client] of Array.from(this.clients.entries())) {
      try {
        if (event.seq > client.cursor) {
          client.webSocket.send(bytes);
          client.cursor = event.seq;
        }
      } catch (error) {
        console.error(`Failed to send to client ${id}:`, error);
        disconnected.push(id);
      }
    }

    for (const id of disconnected) {
      this.clients.delete(id);
    }
  }

  /**
   * Broadcast account event to all connected clients
   */
  private async broadcastAccount(event: AccountEvent): Promise<void> {
    const accountFrame = createAccountFrame({
      seq: event.seq,
      did: event.did,
      time: new Date(event.ts).toISOString(),
      active: event.active,
      status: event.status,
    });
    // Emit compatibility #sync frame as well
    const { createSyncFrame } = await import('../lib/firehose/frames');
    const syncLike = createSyncFrame({
      seq: event.seq,
      did: event.did,
      time: new Date(event.ts).toISOString(),
      active: event.active,
      status: event.status,
    });
    const bytesAccount = accountFrame.toFramedBytes();
    const bytesSync = syncLike.toFramedBytes();

    const disconnected: string[] = [];

    for (const [id, client] of Array.from(this.clients.entries())) {
      try {
        if (event.seq > client.cursor) {
          client.webSocket.send(bytesAccount);
          client.webSocket.send(bytesSync);
          client.cursor = event.seq;
        }
      } catch (error) {
        console.error(`Failed to send to client ${id}:`, error);
        disconnected.push(id);
      }
    }

    for (const id of disconnected) {
      this.clients.delete(id);
    }
  }

  /**
   * Create a #commit frame from event
   */
  private async createCommitFrame(event: CommitEvent): Promise<ReturnType<typeof createCommitFrame>> {
    const commitData = JSON.parse(event.data);

    // If blocks weren't provided, encode them now
    let blocks = event.blocks;
    if (!blocks && event.ops && event.ops.length > 0) {
      try {
        const commitCid = CID.parse(event.commitCid);
        // Extract MST root from commit data
        const mstRoot = commitData.data ? CID.parse(commitData.data) : commitCid;
        blocks = await encodeBlocksForCommit(
          this.env as Env,
          commitCid,
          mstRoot,
          event.ops,
        );
      } catch (error) {
        console.error('Failed to encode blocks for commit:', error);
        blocks = new Uint8Array();
      }
    }

    // Resolve prev commit and since (previous rev) when available
    let prevCid: CID | null = null;
    try {
      if (commitData.prev) prevCid = CID.parse(String(commitData.prev));
    } catch {}

    let since: string | null = null;
    try {
      const db = drizzle(this.db);
      if (prevCid) {
        const prev = await db.select().from(commit_log).where(eq(commit_log.cid, prevCid.toString())).get();
        since = prev?.rev ?? null;
      } else {
        const row = await db.select().from(commit_log).where(gt(commit_log.seq, 0 as any)).orderBy(desc(commit_log.seq)).limit(1).get();
        since = row?.rev ?? null;
      }
    } catch {}

    const message: CommitMessage = {
      seq: event.seq,
      rebase: false,
      tooBig: false,
      repo: event.did,
      commit: CID.parse(event.commitCid),
      prev: prevCid,
      rev: event.rev,
      since,
      blocks: blocks || new Uint8Array(),
      ops: event.ops || [],
      blobs: [],
      time: new Date(event.ts).toISOString(),
    };

    return createCommitFrame(message);
  }

  /**
   * Append commit event to buffer with backpressure
   */
  private appendCommit(event: CommitEvent): void {
    this.buffer.push(event);

    // Implement backpressure: drop oldest events if buffer is full
    if (this.buffer.length > this.maxWindow) {
      const dropped = this.buffer.shift();
      this.droppedFrameCount++;
      console.warn(`Dropped event seq=${dropped?.seq} due to backpressure (total dropped: ${this.droppedFrameCount})`);

      // Send #info frame to all clients about dropped frames
      this.notifyFramesDropped();
    }
  }

  /**
   * Notify all clients that frames were dropped
   */
  private notifyFramesDropped(): void {
    const infoFrame = createInfoFrame(
      'FramesDropped',
      `${this.droppedFrameCount} frame(s) dropped due to backpressure`,
    );
    const bytes = infoFrame.toFramedBytes();

    for (const [id, client] of Array.from(this.clients.entries())) {
      try {
        client.webSocket.send(bytes);
      } catch (error) {
        console.error(`Failed to send info frame to client ${id}:`, error);
      }
    }
  }

  /**
   * Get metrics
   */
  getMetrics(): {
    connectedClients: number;
    bufferSize: number;
    nextSeq: number;
    droppedFrames: number;
  } {
    return {
      connectedClients: this.clients.size,
      bufferSize: this.buffer.length,
      nextSeq: this.nextSeq,
      droppedFrames: this.droppedFrameCount,
    };
  }
}
