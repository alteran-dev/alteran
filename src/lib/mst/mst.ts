import { CID } from 'multiformats/cid';
import * as uint8arrays from 'uint8arrays';
import * as dagCbor from '@ipld/dag-cbor';
import type { ReadableBlockstore } from './blockstore';
import * as util from './util';
import { BlockMap } from './block-map';

/**
 * MST Node Data Structure
 * Represents the CBOR-encoded format of an MST node
 */
export interface NodeData {
  l: CID | null; // left-most subtree
  e: TreeEntry[]; // entries (leaves with optional right subtrees)
}

/**
 * Tree Entry in MST node
 */
export interface TreeEntry {
  p: number; // prefix count shared with previous key
  k: Uint8Array; // rest of key after prefix
  v: CID; // value CID
  t: CID | null; // next subtree (to right of leaf)
}

/**
 * Node entry can be either an MST subtree or a Leaf
 */
export type NodeEntry = MST | Leaf;

export interface MstOpts {
  layer: number;
}

/**
 * Merkle Search Tree (MST) Implementation
 *
 * An ordered, insert-order-independent, deterministic tree structure.
 * Keys are laid out in alphabetic order, with each key hashed to determine
 * which layer it belongs to based on leading zeros (~4 fanout, 2 bits per layer).
 */
export class MST {
  storage: ReadableBlockstore;
  entries: NodeEntry[] | null;
  layer: number | null;
  pointer: CID;
  outdatedPointer = false;

  constructor(
    storage: ReadableBlockstore,
    pointer: CID,
    entries: NodeEntry[] | null,
    layer: number | null,
  ) {
    this.storage = storage;
    this.entries = entries;
    this.layer = layer;
    this.pointer = pointer;
  }

  /**
   * Create a new MST from entries
   */
  static async create(
    storage: ReadableBlockstore,
    entries: NodeEntry[] = [],
    opts?: Partial<MstOpts>,
  ): Promise<MST> {
    const pointer = await cidForEntries(entries);
    const { layer = null } = opts || {};
    return new MST(storage, pointer, entries, layer);
  }

  /**
   * Load MST from NodeData
   */
  static async fromData(
    storage: ReadableBlockstore,
    data: NodeData,
    opts?: Partial<MstOpts>,
  ): Promise<MST> {
    const { layer = null } = opts || {};
    const entries = await deserializeNodeData(storage, data, opts);
    const pointer = await util.cidForCbor(data);
    return new MST(storage, pointer, entries, layer);
  }

  /**
   * Lazy load MST from CID (doesn't fetch from storage yet)
   */
  static load(
    storage: ReadableBlockstore,
    cid: CID,
    opts?: Partial<MstOpts>,
  ): MST {
    const { layer = null } = opts || {};
    return new MST(storage, cid, null, layer);
  }

  /**
   * Create new tree with updated entries (immutable operation)
   */
  async newTree(entries: NodeEntry[]): Promise<MST> {
    const mst = new MST(this.storage, this.pointer, entries, this.layer);
    mst.outdatedPointer = true;
    return mst;
  }

  /**
   * Get entries (lazy load from storage if needed)
   */
  async getEntries(): Promise<NodeEntry[]> {
    if (this.entries) return [...this.entries];

    if (this.pointer) {
      const data = await this.storage.readObj<NodeData>(this.pointer);
      const firstLeaf = data.e[0];
      const layer = firstLeaf !== undefined
        ? await util.leadingZerosOnHash(firstLeaf.k)
        : undefined;

      this.entries = await deserializeNodeData(this.storage, data, { layer });
      return this.entries;
    }

    throw new Error('No entries or CID provided');
  }

  /**
   * Get pointer CID (recalculate if outdated)
   */
  async getPointer(): Promise<CID> {
    if (!this.outdatedPointer) return this.pointer;

    const { cid } = await this.serialize();
    this.pointer = cid;
    this.outdatedPointer = false;
    return this.pointer;
  }

  /**
   * Serialize MST to CBOR bytes
   */
  async serialize(): Promise<{ cid: CID; bytes: Uint8Array }> {
    let entries = await this.getEntries();

    // Update any outdated child pointers first
    const outdated = entries.filter(e => e.isTree() && e.outdatedPointer) as MST[];
    if (outdated.length > 0) {
      await Promise.all(outdated.map(e => e.getPointer()));
      entries = await this.getEntries();
    }

    const data = serializeNodeData(entries);
    const bytes = dagCbor.encode(data);
    const cid = await util.cidForCbor(data);

    return { cid, bytes };
  }

  /**
   * Get layer of this node
   */
  async getLayer(): Promise<number> {
    this.layer = await this.attemptGetLayer();
    if (this.layer === null) this.layer = 0;
    return this.layer;
  }

  async attemptGetLayer(): Promise<number | null> {
    if (this.layer !== null) return this.layer;

    const entries = await this.getEntries();
    let layer = await layerForEntries(entries);

    if (layer === null) {
      for (const entry of entries) {
        if (entry.isTree()) {
          const childLayer = await entry.attemptGetLayer();
          if (childLayer !== null) {
            layer = childLayer + 1;
            break;
          }
        }
      }
    }

    if (layer !== null) this.layer = layer;
    return layer;
  }

  /**
   * Get blocks that need to be stored (not already in storage)
   * This is the key method for efficient block storage - only stores what's new
   */
  async getUnstoredBlocks(): Promise<{ root: CID; blocks: BlockMap }> {
    const blocks = new BlockMap();
    const pointer = await this.getPointer();

    // Check if this node's block is already stored
    const alreadyHas = await this.storage.has(pointer);
    if (alreadyHas) {
      // Block already exists, no need to store anything
      return { root: pointer, blocks };
    }

    // This block doesn't exist - need to serialize and store it
    const entries = await this.getEntries();
    const data = serializeNodeData(entries);
    await blocks.add(data);

    // Recursively collect unstored blocks from child trees
    for (const entry of entries) {
      if (entry.isTree()) {
        const subtree = await entry.getUnstoredBlocks();
        blocks.addMap(subtree.blocks);
      }
    }

    return { root: pointer, blocks };
  }

  /**
   * Add a new key/value pair to the MST
   */
  async add(key: string, value: CID, knownZeros?: number): Promise<MST> {
    util.ensureValidMstKey(key);
    const keyZeros = knownZeros ?? (await util.leadingZerosOnHash(key));
    const layer = await this.getLayer();
    const newLeaf = new Leaf(key, value);

    if (keyZeros === layer) {
      // Key belongs in this layer
      const index = await this.findGtOrEqualLeafIndex(key);
      const found = await this.atIndex(index);

      if (found?.isLeaf() && found.key === key) {
        throw new Error(`There is already a value at key: ${key}`);
      }

      const prevNode = await this.atIndex(index - 1);
      if (!prevNode || prevNode.isLeaf()) {
        return this.spliceIn(newLeaf, index);
      } else {
        const splitSubTree = await prevNode.splitAround(key);
        return this.replaceWithSplit(index - 1, splitSubTree[0], newLeaf, splitSubTree[1]);
      }
    } else if (keyZeros < layer) {
      // Key belongs on a lower layer
      const index = await this.findGtOrEqualLeafIndex(key);
      const prevNode = await this.atIndex(index - 1);

      if (prevNode && prevNode.isTree()) {
        const newSubtree = await prevNode.add(key, value, keyZeros);
        return this.updateEntry(index - 1, newSubtree);
      } else {
        const subTree = await this.createChild();
        const newSubTree = await subTree.add(key, value, keyZeros);
        return this.spliceIn(newSubTree, index);
      }
    } else {
      // Key belongs on a higher layer - push rest of tree down
      const split = await this.splitAround(key);
      let left: MST | null = split[0];
      let right: MST | null = split[1];
      const extraLayersToAdd = keyZeros - layer;

      for (let i = 1; i < extraLayersToAdd; i++) {
        if (left !== null) left = await left.createParent();
        if (right !== null) right = await right.createParent();
      }

      const updated: NodeEntry[] = [];
      if (left) updated.push(left);
      updated.push(new Leaf(key, value));
      if (right) updated.push(right);

      const newRoot = await MST.create(this.storage, updated, { layer: keyZeros });
      newRoot.outdatedPointer = true;
      return newRoot;
    }
  }

  /**
   * Get value for a key
   */
  async get(key: string): Promise<CID | null> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);

    if (found && found.isLeaf() && found.key === key) {
      return found.value;
    }

    const prev = await this.atIndex(index - 1);
    if (prev && prev.isTree()) {
      return prev.get(key);
    }

    return null;
  }

  /**
   * Update value for existing key
   */
  async update(key: string, value: CID): Promise<MST> {
    util.ensureValidMstKey(key);
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);

    if (found && found.isLeaf() && found.key === key) {
      return this.updateEntry(index, new Leaf(key, value));
    }

    const prev = await this.atIndex(index - 1);
    if (prev && prev.isTree()) {
      const updatedTree = await prev.update(key, value);
      return this.updateEntry(index - 1, updatedTree);
    }

    throw new Error(`Could not find a record with key: ${key}`);
  }

  /**
   * Delete a key from the MST
   */
  async delete(key: string): Promise<MST> {
    const altered = await this.deleteRecurse(key);
    return altered.trimTop();
  }

  async deleteRecurse(key: string): Promise<MST> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);

    if (found?.isLeaf() && found.key === key) {
      const prev = await this.atIndex(index - 1);
      const next = await this.atIndex(index + 1);

      if (prev?.isTree() && next?.isTree()) {
        const merged = await prev.appendMerge(next);
        return this.newTree([
          ...(await this.slice(0, index - 1)),
          merged,
          ...(await this.slice(index + 2)),
        ]);
      } else {
        return this.removeEntry(index);
      }
    }

    const prev = await this.atIndex(index - 1);
    if (prev?.isTree()) {
      const subtree = await prev.deleteRecurse(key);
      const subTreeEntries = await subtree.getEntries();

      if (subTreeEntries.length === 0) {
        return this.removeEntry(index - 1);
      } else {
        return this.updateEntry(index - 1, subtree);
      }
    } else {
      throw new Error(`Could not find a record with key: ${key}`);
    }
  }

  /**
   * List entries with optional pagination
   */
  async list(count = Number.MAX_SAFE_INTEGER, after?: string, before?: string): Promise<Leaf[]> {
    const vals: Leaf[] = [];
    for await (const leaf of this.walkLeavesFrom(after || '')) {
      if (leaf.key === after) continue;
      if (vals.length >= count) break;
      if (before && leaf.key >= before) break;
      vals.push(leaf);
    }
    return vals;
  }

  /**
   * List entries with a given prefix
   */
  async listWithPrefix(prefix: string, count = Number.MAX_SAFE_INTEGER): Promise<Leaf[]> {
    const vals: Leaf[] = [];
    for await (const leaf of this.walkLeavesFrom(prefix)) {
      if (vals.length >= count || !leaf.key.startsWith(prefix)) break;
      vals.push(leaf);
    }
    return vals;
  }

  // Helper methods

  async updateEntry(index: number, entry: NodeEntry): Promise<MST> {
    const update = [
      ...(await this.slice(0, index)),
      entry,
      ...(await this.slice(index + 1)),
    ];
    return this.newTree(update);
  }

  async removeEntry(index: number): Promise<MST> {
    const updated = [
      ...(await this.slice(0, index)),
      ...(await this.slice(index + 1)),
    ];
    return this.newTree(updated);
  }

  async atIndex(index: number): Promise<NodeEntry | null> {
    const entries = await this.getEntries();
    return entries[index] ?? null;
  }

  async slice(start?: number, end?: number): Promise<NodeEntry[]> {
    const entries = await this.getEntries();
    return entries.slice(start, end);
  }

  async spliceIn(entry: NodeEntry, index: number): Promise<MST> {
    const update = [
      ...(await this.slice(0, index)),
      entry,
      ...(await this.slice(index)),
    ];
    return this.newTree(update);
  }

  async replaceWithSplit(
    index: number,
    left: MST | null,
    leaf: Leaf,
    right: MST | null,
  ): Promise<MST> {
    const update = await this.slice(0, index);
    if (left) update.push(left);
    update.push(leaf);
    if (right) update.push(right);
    update.push(...(await this.slice(index + 1)));
    return this.newTree(update);
  }

  async trimTop(): Promise<MST> {
    const entries = await this.getEntries();
    if (entries.length === 1 && entries[0].isTree()) {
      return entries[0].trimTop();
    }
    return this;
  }

  async splitAround(key: string): Promise<[MST | null, MST | null]> {
    const index = await this.findGtOrEqualLeafIndex(key);
    const leftData = await this.slice(0, index);
    const rightData = await this.slice(index);
    let left = await this.newTree(leftData);
    let right = await this.newTree(rightData);

    const lastInLeft = leftData[leftData.length - 1];
    if (lastInLeft?.isTree()) {
      left = await left.removeEntry(leftData.length - 1);
      const split = await lastInLeft.splitAround(key);
      if (split[0]) left = await left.append(split[0]);
      if (split[1]) right = await right.prepend(split[1]);
    }

    return [
      (await left.getEntries()).length > 0 ? left : null,
      (await right.getEntries()).length > 0 ? right : null,
    ];
  }

  async appendMerge(toMerge: MST): Promise<MST> {
    if ((await this.getLayer()) !== (await toMerge.getLayer())) {
      throw new Error('Trying to merge two nodes from different layers of the MST');
    }

    const thisEntries = await this.getEntries();
    const toMergeEntries = await toMerge.getEntries();
    const lastInLeft = thisEntries[thisEntries.length - 1];
    const firstInRight = toMergeEntries[0];

    if (lastInLeft?.isTree() && firstInRight?.isTree()) {
      const merged = await lastInLeft.appendMerge(firstInRight);
      return this.newTree([
        ...thisEntries.slice(0, thisEntries.length - 1),
        merged,
        ...toMergeEntries.slice(1),
      ]);
    } else {
      return this.newTree([...thisEntries, ...toMergeEntries]);
    }
  }

  async append(entry: NodeEntry): Promise<MST> {
    const entries = await this.getEntries();
    return this.newTree([...entries, entry]);
  }

  async prepend(entry: NodeEntry): Promise<MST> {
    const entries = await this.getEntries();
    return this.newTree([entry, ...entries]);
  }

  async createChild(): Promise<MST> {
    const layer = await this.getLayer();
    return MST.create(this.storage, [], { layer: layer - 1 });
  }

  async createParent(): Promise<MST> {
    const layer = await this.getLayer();
    const parent = await MST.create(this.storage, [this], { layer: layer + 1 });
    parent.outdatedPointer = true;
    return parent;
  }

  async findGtOrEqualLeafIndex(key: string): Promise<number> {
    const entries = await this.getEntries();
    const maybeIndex = entries.findIndex(entry => entry.isLeaf() && entry.key >= key);
    return maybeIndex >= 0 ? maybeIndex : entries.length;
  }

  async *walkFrom(key: string): AsyncIterable<NodeEntry> {
    yield this;
    const index = await this.findGtOrEqualLeafIndex(key);
    const entries = await this.getEntries();
    const found = entries[index];

    if (found && found.isLeaf() && found.key === key) {
      yield found;
    } else {
      const prev = entries[index - 1];
      if (prev) {
        if (prev.isLeaf() && prev.key === key) {
          yield prev;
        } else if (prev.isTree()) {
          yield* prev.walkFrom(key);
        }
      }
    }

    for (let i = index; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.isLeaf()) {
        yield entry;
      } else {
        yield* entry.walkFrom(key);
      }
    }
  }

  async *walkLeavesFrom(key: string): AsyncIterable<Leaf> {
    for await (const node of this.walkFrom(key)) {
      if (node.isLeaf()) {
        yield node;
      }
    }
  }

  isTree(): this is MST {
    return true;
  }

  isLeaf(): this is Leaf {
    return false;
  }
}

/**
 * Leaf node in the MST
 */
export class Leaf {
  constructor(
    public key: string,
    public value: CID,
  ) {}

  isTree(): this is MST {
    return false;
  }

  isLeaf(): this is Leaf {
    return true;
  }

  equals(entry: NodeEntry): boolean {
    if (entry.isLeaf()) {
      return this.key === entry.key && this.value.equals(entry.value);
    }
    return false;
  }
}

// Utility functions

async function layerForEntries(entries: NodeEntry[]): Promise<number | null> {
  const firstLeaf = entries.find(entry => entry.isLeaf());
  if (!firstLeaf || firstLeaf.isTree()) return null;
  return await util.leadingZerosOnHash(firstLeaf.key);
}

async function deserializeNodeData(
  storage: ReadableBlockstore,
  data: NodeData,
  opts?: Partial<MstOpts>,
): Promise<NodeEntry[]> {
  const { layer } = opts || {};
  const entries: NodeEntry[] = [];

  if (data.l !== null) {
    entries.push(MST.load(storage, data.l, { layer: layer ? layer - 1 : undefined }));
  }

  let lastKey = '';
  for (const entry of data.e) {
    const keyStr = uint8arrays.toString(entry.k, 'ascii');
    const key = lastKey.slice(0, entry.p) + keyStr;
    util.ensureValidMstKey(key);
    entries.push(new Leaf(key, entry.v));
    lastKey = key;

    if (entry.t !== null) {
      entries.push(MST.load(storage, entry.t, { layer: layer ? layer - 1 : undefined }));
    }
  }

  return entries;
}

function serializeNodeData(entries: NodeEntry[]): NodeData {
  const data: NodeData = { l: null, e: [] };
  let i = 0;

  if (entries[0]?.isTree()) {
    i++;
    data.l = entries[0].pointer;
  }

  let lastKey = '';
  while (i < entries.length) {
    const leaf = entries[i];
    const next = entries[i + 1];

    if (!leaf.isLeaf()) {
      throw new Error('Not a valid node: two subtrees next to each other');
    }
    i++;

    let subtree: CID | null = null;
    if (next?.isTree()) {
      subtree = next.pointer;
      i++;
    }

    util.ensureValidMstKey(leaf.key);
    const prefixLen = util.countPrefixLen(lastKey, leaf.key);
    data.e.push({
      p: prefixLen,
      k: uint8arrays.fromString(leaf.key.slice(prefixLen), 'ascii'),
      v: leaf.value,
      t: subtree,
    });

    lastKey = leaf.key;
  }

  return data;
}

async function cidForEntries(entries: NodeEntry[]): Promise<CID> {
  const data = serializeNodeData(entries);
  return util.cidForCbor(data);
}