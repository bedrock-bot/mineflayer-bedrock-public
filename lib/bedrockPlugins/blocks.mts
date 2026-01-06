import type { BedrockBot } from '../../index.js';
import { Vec3 } from 'vec3';
import assert from 'assert';
import { onceWithCleanup } from '../promise_utils.js';
import fs from 'fs';
import { createRequire } from 'module';
import type { BedrockChunk } from 'prismarine-chunk';
const require = createRequire(import.meta.url);

const { BlobEntry, BlobType } = require('prismarine-chunk');
const BlobStore = require('../BlobStore');

const { OctahedronIterator } = require('prismarine-world/src/iterators');

const serialize = (obj: any) => JSON.stringify(obj, (k, v) => (typeof v?.valueOf?.() === 'bigint' ? v.toString() : v));

const dimensionNames: Record<string, string> = {
  '-1': 'minecraft:nether',
  0: 'minecraft:overworld',
  1: 'minecraft:end',
};

interface BlocksOptions {
  version?: string;
  storageBuilder?: any;
  hideErrors?: boolean;
}

export default function inject(bot: BedrockBot, { version, storageBuilder, hideErrors }: BlocksOptions = {}) {
  // const registry = bot._client.host !== 'mco.cubecraft.net' ? bot.registry : require('prismarine-registry')('bedrock_1.18.30')
  const Block = require('prismarine-block')(bot.registry);
  const Chunk = require('prismarine-chunk')(bot.registry); // bot.registry ChunkColumn bot.registry
  const World = require('prismarine-world')(bot.registry);
  const blobStore = new BlobStore();

  function delColumn(chunkX: number, chunkZ: number) {
    bot.world.unloadColumn(chunkX, chunkZ);
  }
  // load chunk into a column
  function addColumn(args: any) {
    try {
      bot.world.setColumn(args.x, args.z, args.column);
    } catch (e) {
      bot.emit('error', e);
    }
  }

  async function waitForChunksToLoad() {
    const dist = 4;
    // This makes sure that the bot's real position has been already sent
    if (!bot.entity.height) await onceWithCleanup(bot, 'chunkColumnLoad');
    const pos = bot.entity.position;
    const center = new Vec3((pos.x >> 4) << 4, 0, (pos.z >> 4) << 4);
    // get corner coords of 5x5 chunks around us
    const chunkPosToCheck = new Set<string>();
    for (let x = -dist; x <= dist; x++) {
      for (let y = -dist; y <= dist; y++) {
        // ignore any chunks which are already loaded
        const pos = center.plus(new Vec3(x, 0, y).scaled(16));
        if (!bot.world.getColumnAt(pos)) chunkPosToCheck.add(pos.toString());
      }
    }

    if (chunkPosToCheck.size) {
      return new Promise<void>((resolve) => {
        function waitForLoadEvents(columnCorner: Vec3) {
          chunkPosToCheck.delete(columnCorner.toString());
          if (chunkPosToCheck.size === 0) {
            // no chunks left to find
            bot.world.off('chunkColumnLoad', waitForLoadEvents); // remove this listener instance
            resolve();
          }
        }

        // begin listening for remaining chunks to load
        bot.world.on('chunkColumnLoad', waitForLoadEvents);
      });
    }
  }

  bot._client.on('join', () => {
    bot._client.queue('client_cache_status', { enabled: cachingEnabled });
  });

  // this would go in pworld
  let subChunkMissHashes: any[] = [];
  let sentMiss = false;
  let gotMiss = false;
  let lostSubChunks = 0,
    foundSubChunks = 0;

  const cachingEnabled = false;

  //let points = []
  async function processLevelChunk(packet: any) {
    const cc = new Chunk({ x: packet.x, z: packet.z });
    if (!cachingEnabled) {
      await cc.networkDecodeNoCache(packet.payload, packet.sub_chunk_count);
    } else if (cachingEnabled) {
      const misses = await cc.networkDecode(packet.blobs.hashes, blobStore, packet.payload);
      if (!packet.blobs.hashes.length) return; // no blobs

      bot._client.queue('client_cache_blob_status', {
        misses: misses.length,
        haves: 0,
        have: [],
        missing: misses,
      });

      if (packet.sub_chunk_count < 0) {
        // 1.18+
        for (const miss of misses) blobStore.addPending(miss, new BlobEntry({ type: BlobType.Biomes, x: packet.x, z: packet.z }));
      } else {
        // 1.17-
        const lastBlob = packet.blobs.hashes[packet.blobs.hashes.length - 1];
        for (const miss of misses) {
          blobStore.addPending(
            miss,
            new BlobEntry({
              type: miss === lastBlob ? BlobType.Biomes : BlobType.ChunkSection,
              x: packet.x,
              z: packet.z,
            })
          );
        }
        sentMiss = true;
      }

      blobStore.once(misses, async () => {
        // The things we were missing have now arrived
        const now = await cc.networkDecode(packet.blobs.hashes, blobStore, packet.payload);
        fs.writeFileSync(
          `fixtures/${version}/level_chunk CacheMissResponse ${packet.x},${packet.z}.json`,
          serialize({
            blobs: Object.fromEntries(packet.blobs.hashes.map((h: any) => [h.toString(), blobStore.get(h).buffer])),
          })
        );
        assert.strictEqual(now.length, 0);

        bot._client.queue('client_cache_blob_status', {
          misses: 0,
          haves: packet.blobs.hashes.length,
          have: packet.blobs.hashes,
          missing: [],
        });

        gotMiss = true;
      });
    }

    if (packet.sub_chunk_count < 0) {
      // 1.18.0+
      // 1.18+ handling, we need to send a SubChunk request
      const maxSubChunkCount = packet.highest_subchunk_count || 5; // field is set if sub_chunk_count=-2 (1.18.10+) meaning all air

      function getChunkCoordinates(pos: Vec3) {
        let chunkX = Math.floor(pos.x / 16);
        let chunkZ = Math.floor(pos.z / 16);
        let subchunkY = Math.floor(pos.y / 16);
        return { chunkX: chunkX, chunkZ: chunkZ, subchunkY: subchunkY };
      }

      if (bot.registry.version['>=']('1.18.11')) {
        // We can send the request in one big load!
        // let origin = getChunkCoordinates(bot.entity.position)
        // let x = packet.x <= 0 ? 255 + packet.x : packet.x
        // let z = packet.z <= 0 ? 255 + packet.z : packet.z

        let requests: any[] = [];

        let offset = cc.minCY;
        // load all height of the chunk
        for (let i = offset; i <= offset + maxSubChunkCount; i++) {
          requests.push({ dx: 0, dz: 0, dy: i });
        }
        if (requests.length > 0) {
          bot._client.queue('subchunk_request', {
            origin: { x: packet.x, z: packet.z, y: 0 },
            requests,
            dimension: 0,
          });
        }
      } else if (bot.registry.version['>=']('1.18')) {
        for (let i = 1; i < maxSubChunkCount; i++) {
          // Math.min(maxSubChunkCount, 5)
          bot._client.queue('subchunk_request', {
            x: packet.x,
            z: packet.z,
            y: 0,
            dimension: 0,
          } as any);
        }
      }
    }

    addColumn({
      x: packet.x,
      z: packet.z,
      column: cc,
    });
  }

  async function loadCached(cc: any, x: number, y: number, z: number, blobId: any, extraData: any) {
    const misses = await cc.networkDecodeSubChunk([blobId], blobStore, extraData);
    subChunkMissHashes.push(...misses);

    for (const miss of misses) {
      blobStore.addPending(miss, new BlobEntry({ type: BlobType.ChunkSection, x, z, y }));
    }

    if (subChunkMissHashes.length >= 10) {
      sentMiss = true;
      const r = {
        misses: subChunkMissHashes.length,
        haves: 0,
        have: [],
        missing: subChunkMissHashes,
      };

      bot._client.queue('client_cache_blob_status', r);
      subChunkMissHashes = [];
    }

    if (misses.length) {
      const [missed] = misses;
      // Once we get this blob, try again

      blobStore.once([missed], async () => {
        gotMiss = true;
        fs.writeFileSync(
          `fixtures/${version}/subchunk CacheMissResponse ${x},${z},${y}.json`,
          serialize({
            blobs: Object.fromEntries([[missed.toString(), blobStore.get(missed).buffer]]),
          })
        );
        // Call this again, ignore the payload since that's already been decoded
        const misses = await cc.networkDecodeSubChunk([missed], blobStore);
        assert(!misses.length, 'Should not have missed anything');
      });
    }
  }

  async function processSubChunk(packet: protocolTypes.packet_subchunk) {
    const pkt = packet as any;
    if (pkt.entries) {
      // 1.18.10+ handling
      for (const entry of pkt.entries) {
        const x = pkt.origin.x + entry.dx;
        const y = pkt.origin.y + Buffer.from([entry.dy]).readInt8(0);
        const z = pkt.origin.z + entry.dz;

        const cc = bot.world.getColumn(x, z) as BedrockChunk;

        if (entry.result === 'success') {
          foundSubChunks++;
          if (pkt.cache_enabled) {
            await loadCached(cc, x, y, z, entry.blob_id, entry.payload);
          } else {
            try {
              await cc.networkDecodeSubChunkNoCache(y, entry.payload);
              bot.world.emit('chunkColumnLoad', new Vec3(x, y, z));
            } catch (e) {
              bot.logger.error(e);
            }
          }
        } else {
          lostSubChunks++;
        }
      }
    } else {
      if (pkt.request_result !== 'success') {
        lostSubChunks++;
        return;
      }
      foundSubChunks++;
      const cc = bot.world.getColumn(pkt.x, pkt.z) as BedrockChunk;
      if (pkt.cache_enabled) {
        await loadCached(cc, pkt.x, pkt.y, pkt.z, pkt.blob_id, pkt.data);
      } else {
        await cc.networkDecodeSubChunkNoCache(pkt.y, pkt.data);
      }
    }
  }

  async function processCacheMiss(packet: any) {
    const acks: any[] = [];
    for (const { hash, payload } of packet.blobs) {
      const name = hash.toString();
      blobStore.updatePending(name, { buffer: payload });
      acks.push(hash);
    }

    // Send back an ACK
    bot._client.queue('client_cache_blob_status', {
      misses: 0,
      haves: acks.length,
      have: [],
      missing: acks,
    });
  }

  bot._client.on('level_chunk', processLevelChunk);
  bot._client.on('subchunk', (sc) => processSubChunk(sc).catch(console.error));
  bot._client.on('client_cache_miss_response', processCacheMiss);

  // fs.mkdirSync(`fixtures/${version}/pchunk`, { recursive: true })
  // bot._client.on('packet', ({ data: { name, params }, fullBuffer }) => {
  //   if (name === 'level_chunk') {
  //     fs.writeFileSync(`fixtures/${version}/level_chunk ${cachingEnabled ? 'cached' : ''} ${params.x},${params.z}.json`, serialize(params))
  //   } else if (name === 'subchunk') {
  //     if (params.origin) {
  //       fs.writeFileSync(`fixtures/${version}/subchunk ${cachingEnabled ? 'cached' : ''} ${params.origin.x},${params.origin.z},${params.origin.y}.json`, serialize(params))
  //     } else {
  //       fs.writeFileSync(`fixtures/${version}/subchunk ${cachingEnabled ? 'cached' : ''} ${params.x},${params.z},${params.y}.json`, serialize(params))
  //     }
  //   }
  // })

  function getMatchingFunction(matching: any) {
    if (typeof matching !== 'function') {
      if (!Array.isArray(matching)) {
        matching = [matching];
      }
      return isMatchingType;
    }
    return matching;

    function isMatchingType(block: any) {
      return block === null ? false : matching.indexOf(block.type) >= 0;
    }
  }

  function isBlockInSection(section: any, matcher: any) {
    if (!section) return false; // section is empty, skip it (yay!)
    // If the chunk use a palette we can speed up the search by first
    // checking the palette which usually contains less than 20 ids
    // vs checking the 4096 block of the section. If we don't have a
    // match in the palette, we can skip this section.
    if (section.palette) {
      for (const stateId of section.palette[0]) {
        if (matcher(Block.fromStateId(stateId.stateId, 0))) {
          return true; // the block is in the palette
        }
      }
      return false; // skip
    }
    return true; // global palette, the block might be in there
  }

  function getFullMatchingFunction(matcher: any, useExtraInfo: any) {
    if (typeof useExtraInfo === 'boolean') {
      return fullSearchMatcher;
    }

    return nonFullSearchMatcher;

    function nonFullSearchMatcher(point: Vec3) {
      const block = blockAt(point, true);
      return matcher(block) && useExtraInfo(block);
    }

    function fullSearchMatcher(point: Vec3) {
      return matcher(bot.blockAt(point, useExtraInfo));
    }
  }

  bot.findBlocks = (options: any) => {
    const matcher = getMatchingFunction(options.matching);
    const point = (options.point || bot.entity.position).floored();
    const maxDistance = options.maxDistance || 16;
    const count = options.count || 1;
    const useExtraInfo = options.useExtraInfo || false;
    const fullMatcher = getFullMatchingFunction(matcher, useExtraInfo);
    const start = new Vec3(Math.floor(point.x / 16), Math.floor(point.y / 16), Math.floor(point.z / 16));
    const it = new OctahedronIterator(start, Math.ceil((maxDistance + 8) / 16));
    // the octahedron iterator can sometime go through the same section again
    // we use a set to keep track of visited sections
    const visitedSections = new Set<string>();

    let blocks: Vec3[] = [];
    let startedLayer = 0;
    let next = start;
    while (next) {
      const column = bot.world.getColumn(next.x, next.z) as any;
      const sectionY = next.y + Math.abs(bot.game.minY >> 4);
      const totalSections = bot.game.height >> 4;
      if (sectionY >= 0 && sectionY < totalSections && column && !visitedSections.has(next.toString())) {
        const section = column.sections[sectionY];
        if (useExtraInfo === true || isBlockInSection(section, matcher)) {
          const begin = new Vec3(next.x * 16, sectionY * 16 + bot.game.minY, next.z * 16);
          const cursor = begin.clone();
          const end = cursor.offset(16, 16, 16);
          for (cursor.x = begin.x; cursor.x < end.x; cursor.x++) {
            for (cursor.y = begin.y; cursor.y < end.y; cursor.y++) {
              for (cursor.z = begin.z; cursor.z < end.z; cursor.z++) {
                if (fullMatcher(cursor) && cursor.distanceTo(point) <= maxDistance) blocks.push(cursor.clone());
              }
            }
          }
        }
        visitedSections.add(next.toString());
      }
      // If we started a layer, we have to finish it otherwise we might miss closer blocks
      if (startedLayer !== it.apothem && blocks.length >= count) {
        break;
      }
      startedLayer = it.apothem;
      next = it.next();
    }
    blocks.sort((a, b) => {
      return a.distanceTo(point) - b.distanceTo(point);
    });
    // We found more blocks than needed, shorten the array to not confuse people
    if (blocks.length > count) {
      blocks = blocks.slice(0, count);
    }
    return blocks;
  };

  function findBlock(options: any) {
    const blocks = bot.findBlocks(options);
    if (blocks.length === 0) return null;
    return bot.blockAt(blocks[0]);
  }

  function blockAt(absolutePoint: Vec3, extraInfos = true) {
    const block = bot.world.getBlock(absolutePoint);
    // null block means chunk not loaded
    if (!block) return null;

    // Apply per-state collision shapes for Bedrock dynamic blocks
    const collisionShapes = bot.registry.blockCollisionShapes;
    const blockType = bot.registry.blocks[block.type];

    if (blockType?.shapeType == null) {
      return block;
    }

    const dynamicShapes = collisionShapes?.dynamicShapes?.[blockType.shapeType];
    if (!dynamicShapes) return block;

    let shapeIndex: number;
    const pos = block.position;

    if (blockType.shapeType === 'stairs') {
      // Stairs: index = direction*10 + half*5 + cornerShape
      // direction: 0=East, 1=West, 2=South, 3=North (weirdo_direction)
      // half: 0=bottom, 1=top (upside_down_bit)
      // cornerShape: 0=straight, 1=inner_left, 2=inner_right, 3=outer_left, 4=outer_right
      const props = block.getProperties?.() ?? {};
      const direction = props.weirdo_direction ?? 0;
      const upsideDown = props.upside_down_bit ? 1 : 0;
      const cornerShape = calculateStairCornerShape(block, direction, upsideDown);
      shapeIndex = direction * 10 + upsideDown * 5 + cornerShape;
    } else if (blockType.shapeType === 'chorus') {
      // Chorus plant: 6-bit bitmask for all 6 directions
      // index = down + east*2 + north*4 + south*8 + up*16 + west*32
      shapeIndex = 0;
      const directions = [
        { dx: 0, dy: -1, dz: 0, bit: 1 },   // Down
        { dx: 1, dy: 0, dz: 0, bit: 2 },    // East
        { dx: 0, dy: 0, dz: -1, bit: 4 },   // North
        { dx: 0, dy: 0, dz: 1, bit: 8 },    // South
        { dx: 0, dy: 1, dz: 0, bit: 16 },   // Up
        { dx: -1, dy: 0, dz: 0, bit: 32 }   // West
      ];
      for (const { dx, dy, dz, bit } of directions) {
        const neighbor = bot.world.getBlock(pos.offset(dx, dy, dz));
        if (neighbor) {
          const neighborType = bot.registry.blocks[neighbor.type];
          const name = neighborType?.name;
          const connects = name === 'chorus_plant' || name === 'chorus_flower' ||
                          (bit === 1 && name === 'end_stone'); // Down connects to end_stone
          if (connects) shapeIndex |= bit;
        }
      }
    } else {
      // Fences/panes: 4-bit bitmask (N=1, S=2, E=4, W=8)
      shapeIndex = 0;
      const directions = [
        { dx: 0, dz: -1, bit: 1 },  // North
        { dx: 0, dz: 1, bit: 2 },   // South
        { dx: 1, dz: 0, bit: 4 },   // East
        { dx: -1, dz: 0, bit: 8 }   // West
      ];

      for (const { dx, dz, bit } of directions) {
        const neighbor = bot.world.getBlock(pos.offset(dx, 0, dz));
        if (neighbor) {
          const neighborType = bot.registry.blocks[neighbor.type];
          const isSolid = neighbor.boundingBox === 'block';
          const isSameType = neighbor.type === block.type;
          const connectsFence = blockType.shapeType === 'fence' && neighborType?.shapeType === 'fence';
          const connectsPane = blockType.shapeType === 'pane' && neighborType?.shapeType === 'pane';
          if (isSolid || isSameType || connectsFence || connectsPane) {
            shapeIndex |= bit;
          }
        }
      }
    }

    const shapeId = dynamicShapes[shapeIndex];
    if (shapeId !== undefined) {
      block.shapes = collisionShapes.shapes[shapeId];
    }

    return block;
  }

  // Calculate stair corner shape based on neighboring stairs
  function calculateStairCornerShape(block: any, facing: number, upsideDown: number): number {
    // 0=Straight, 1=Inner Left, 2=Inner Right, 3=Outer Left, 4=Outer Right
    const pos = block.position;

    // Get front and back offsets based on facing direction
    // facing: 0=East(+X), 1=West(-X), 2=South(+Z), 3=North(-Z)
    const offsets: Record<number, { front: [number, number], back: [number, number] }> = {
      0: { front: [1, 0], back: [-1, 0] },   // East
      1: { front: [-1, 0], back: [1, 0] },   // West
      2: { front: [0, 1], back: [0, -1] },   // South
      3: { front: [0, -1], back: [0, 1] }    // North
    };
    const offset = offsets[facing];
    if (!offset) return 0;

    const frontBlock = bot.world.getBlock(pos.offset(offset.front[0], 0, offset.front[1]));
    const backBlock = bot.world.getBlock(pos.offset(offset.back[0], 0, offset.back[1]));

    // Check for inner corner (stair in front, perpendicular facing)
    if (frontBlock) {
      const frontType = bot.registry.blocks[frontBlock.type];
      if (frontType?.shapeType === 'stairs') {
        const frontProps = frontBlock.getProperties?.() ?? {};
        const frontUpsideDown = frontProps.upside_down_bit ? 1 : 0;
        if (frontUpsideDown === upsideDown) {
          const frontFacing = frontProps.weirdo_direction ?? 0;
          if (isPerpendicularLeft(facing, frontFacing)) return 1;  // Inner Left
          if (isPerpendicularRight(facing, frontFacing)) return 2; // Inner Right
        }
      }
    }

    // Check for outer corner (stair behind, perpendicular facing)
    if (backBlock) {
      const backType = bot.registry.blocks[backBlock.type];
      if (backType?.shapeType === 'stairs') {
        const backProps = backBlock.getProperties?.() ?? {};
        const backUpsideDown = backProps.upside_down_bit ? 1 : 0;
        if (backUpsideDown === upsideDown) {
          const backFacing = backProps.weirdo_direction ?? 0;
          if (isPerpendicularLeft(facing, backFacing)) return 3;  // Outer Left
          if (isPerpendicularRight(facing, backFacing)) return 4; // Outer Right
        }
      }
    }

    return 0; // Straight
  }

  // Check if otherFacing is 90 degrees counter-clockwise from facing
  function isPerpendicularLeft(facing: number, otherFacing: number): boolean {
    const leftOf: Record<number, number> = { 0: 3, 1: 2, 2: 0, 3: 1 }; // E->N, W->S, S->E, N->W
    return otherFacing === leftOf[facing];
  }

  // Check if otherFacing is 90 degrees clockwise from facing
  function isPerpendicularRight(facing: number, otherFacing: number): boolean {
    const rightOf: Record<number, number> = { 0: 2, 1: 3, 2: 1, 3: 0 }; // E->S, W->N, S->W, N->E
    return otherFacing === rightOf[facing];
  }

  // if passed in block is within line of sight to the bot, returns true
  // also works on anything with a position value
  function canSeeBlock(block: any) {
    const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
    const range = headPos.distanceTo(block.position);
    const dir = block.position.offset(0.5, 0.5, 0.5).minus(headPos);
    const match = (inputBlock: any, iter: any) => {
      const intersect = iter.intersect(inputBlock.shapes, inputBlock.position);
      if (intersect) {
        return true;
      }
      return block.position.equals(inputBlock.position);
    };
    const blockAtCursor = bot.world.raycast(headPos, dir.normalize(), range, match as any);
    return blockAtCursor && blockAtCursor.position.equals(block.position);
  }

  function updateBlockEntityData(point: Vec3, nbt: any) {
    const column = bot.world.getColumnAt(point) as any;
    if (!column) return;

    if (nbt) {
      column.setBlockEntity(posInChunk(point), nbt);
    } else {
      const debug = bot.world.getBlock(point);
      if (debug.entity) bot.logger.debug('Removed Entity Data');

      column.removeBlockEntity(posInChunk(point));
    }

    const block = bot.world.getBlock(point);
    bot.world.emit('blockUpdate', block, block);
  }

  function posInChunk(pos: Vec3) {
    return new Vec3(Math.floor(pos.x) & 15, Math.floor(pos.y), Math.floor(pos.z) & 15);
  }

  function updateBlockState(point: Vec3, block_runtime_id: number) {
    const registry = bot.registry as any;
    if (!registry.blocksByRuntimeId) {
      bot.logger.warn('registry.blocksByRuntimeId is not available');
      return;
    }
    let registryBlock = registry.blocksByRuntimeId[block_runtime_id];
    if (!registryBlock) registryBlock = bot.registry.blocksByName['stone'];

    // Create a new block object with stateId set to the runtime ID
    // This is needed for openBlock() to send the correct block_runtime_id
    const block = {
      ...registryBlock,
      stateId: block_runtime_id,
    };

    const oldBlock = bot.world.getBlock(point);

    if (oldBlock && oldBlock.stateId === block_runtime_id) {
      bot.world.emit('blockUpdate', oldBlock, oldBlock);
      return;
    }

    //Rather use bot.registry.blocksByStateId[stateId]?
    if (oldBlock)
      if (oldBlock.type !== block.type) {
        updateBlockEntityData(point, null);
      }

    bot.world.setBlock(point, block);

    // Emit position-specific blockUpdate event for digging plugin
    const newBlock = blockAt(point);
    if (newBlock !== null) {
      bot.world.emit(`blockUpdate:${point}`, oldBlock, newBlock);
    }
  }

  // bot._client.on('map_chunk', (packet) => {
  //   addColumn({
  //     x: packet.x,
  //     z: packet.z,
  //     bitMap: packet.bitMap,
  //     heightmaps: packet.heightmaps,
  //     biomes: packet.biomes,
  //     skyLightSent: bot.game.dimension === 'minecraft:overworld',
  //     groundUp: packet.groundUp,
  //     data: packet.chunkData,
  //     trustEdges: packet.trustEdges,
  //     skyLightMask: packet.skyLightMask,
  //     blockLightMask: packet.blockLightMask,
  //     emptySkyLightMask: packet.emptySkyLightMask,
  //     emptyBlockLightMask: packet.emptyBlockLightMask,
  //     skyLight: packet.skyLight,
  //     blockLight: packet.blockLight
  //   })
  //
  //   if (typeof packet.blockEntities !== 'undefined') {
  //     const column = bot.world.getColumn(packet.x, packet.z)
  //     if (!column) {
  //       if (!hideErrors) console.warn('Ignoring block entities as chunk failed to load at', packet.x, packet.z)
  //       return
  //     }
  //     for (const blockEntity of packet.blockEntities) {
  //       if (blockEntity.x !== undefined) { // 1.17+
  //         column.setBlockEntity(blockEntity, blockEntity.nbtData)
  //       } else {
  //         const pos = new Vec3(blockEntity.value.x.value & 0xf, blockEntity.value.y.value, blockEntity.value.z.value & 0xf)
  //         column.setBlockEntity(pos, blockEntity)
  //       }
  //     }
  //   }
  // })

  // bot._client.on('map_chunk_bulk', (packet) => {
  //   let offset = 0
  //   let meta
  //   let i
  //   let size
  //   for (i = 0; i < packet.meta.length; ++i) {
  //     meta = packet.meta[i]
  //     size = (8192 + (packet.skyLightSent ? 2048 : 0)) *
  //       onesInShort(meta.bitMap) + // block ids
  //       2048 * onesInShort(meta.bitMap) + // (two bytes per block id)
  //       256 // biomes
  //     addColumn({
  //       x: meta.x,
  //       z: meta.z,
  //       bitMap: meta.bitMap,
  //       heightmaps: packet.heightmaps,
  //       skyLightSent: packet.skyLightSent,
  //       groundUp: true,
  //       data: packet.data.slice(offset, offset + size)
  //     })
  //     offset += size
  //   }
  //
  //   assert.strictEqual(offset, packet.data.length)
  // })

  bot._client.on('update_subchunk_blocks', (packet) => {
    // Packet Update Subchunk Blocks
    // multi block change
    // EXTRA NOT IMPLEMENTED (WATERLOGGED)
    for (let i = 0; i < packet.blocks.length; i++) {
      const record = packet.blocks[i];
      const pt = new Vec3(record.position.x, record.position.y, record.position.z);
      updateBlockState(pt, record.runtime_id);
    }
  });

  bot._client.on('update_block', (packet) => {
    const pt = new Vec3(packet.position.x, packet.position.y, packet.position.z) as any;
    pt.l = packet.layer;
    updateBlockState(pt, packet.block_runtime_id);
  });

  bot._client.on('block_entity_data', (packet) => {
    const pt = new Vec3(packet.position.x, packet.position.y, packet.position.z);
    updateBlockEntityData(pt, packet.nbt);
  });

  // bot._client.on('explosion', (packet) => {
  //   // explosion
  //   const p = new Vec3(packet.x, packet.y, packet.z)
  //   packet.affectedBlockOffsets.forEach((offset) => {
  //     const pt = p.offset(offset.x, offset.y, offset.z)
  //     updateBlockState(pt, 0)
  //   })
  // }) // NO EXP PACKET ON BEDROCK

  // if we get a respawn packet and the dimension is changed,
  // unload all chunks from memory.
  let dimension: any;
  let worldName: any;
  function dimensionToFolderName(dimension: any) {
    if (bot.supportFeature('dimensionIsAnInt')) {
      return dimensionNames[dimension];
    } else if (bot.supportFeature('dimensionIsAString') || bot.supportFeature('dimensionIsAWorld')) {
      return dimension;
    }
  }

  async function switchWorld() {
    if (bot.world) {
      if (storageBuilder) {
        await bot.world.async.waitSaving();
      }

      for (const [name, listener] of Object.entries((bot as any)._events) as [string, any][]) {
        if (name.startsWith('blockUpdate:')) {
          bot.emit(name as any, null, null);
          bot.off(name as any, listener as any);
        }
      }

      const worldAsync = bot.world.async as any;
      for (const [x, z] of Object.keys(worldAsync.columns).map((key) => key.split(',').map((x) => parseInt(x, 10)))) {
        bot.world.unloadColumn(x, z);
      }

      if (storageBuilder) {
        worldAsync.storageProvider = storageBuilder({
          version: bot.version,
          worldName: dimensionToFolderName(dimension),
        });
      }
    } else {
      bot.world = new World(null, storageBuilder ? storageBuilder({ version: bot.version, worldName: dimensionToFolderName(dimension) }) : null).sync;
      startListenerProxy();
    }
  }

  bot._client.on('start_game', (packet) => {
    if (bot.supportFeature('dimensionIsAnInt')) {
      dimension = packet.dimension;
    } else {
      dimension = packet.dimension;
      worldName = packet.world_name;
    }
    switchWorld();
  });

  bot._client.on('respawn', (packet) => {
    const pkt = packet as any;
    if (bot.supportFeature('dimensionIsAnInt')) {
      // <=1.15.2
      if (dimension === pkt.dimension) return;
      dimension = pkt.dimension;
    } else {
      // >= 1.15.2
      if (dimension === pkt.dimension) return;
      if (worldName === pkt.world_name && pkt.copyMetadata === true) return; // don't unload chunks if in same world and metaData is true
      // Metadata is true when switching dimensions however, then the world name is different packet.copyMetadata unavaliable for bedrock!!!
      dimension = pkt.dimension;
      worldName = pkt.world_name;
    }
    switchWorld();
  });

  let listener: any;
  let listenerRemove: any;
  function startListenerProxy() {
    if (listener) {
      // custom forwarder for custom events
      bot.off('newListener', listener);
      bot.off('removeListener', listenerRemove);
    }
    // standardized forwarding
    const forwardedEvents = ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload'];

    for (const event of forwardedEvents) {
      bot.world.on(event, (...args: any[]) => (bot.emit as any)(event, ...args));
    }
    const blockUpdateRegex = /blockUpdate:\(-?\d+, -?\d+, -?\d+\)/;
    listener = (event: string, listener: any) => {
      if (blockUpdateRegex.test(event)) {
        bot.world.on(event, listener);
      }
    };
    listenerRemove = (event: string, listener: any) => {
      if (blockUpdateRegex.test(event)) {
        bot.world.off(event, listener);
      }
    };
    bot.on('newListener', listener);
    bot.on('removeListener', listenerRemove);
  }

  bot.findBlock = findBlock;
  bot.canSeeBlock = canSeeBlock;
  bot.blockAt = blockAt;
  bot._updateBlockState = updateBlockState;
  bot.waitForChunksToLoad = waitForChunksToLoad;
}

// function onesInShort (n) {
//   n = n & 0xffff
//   let count = 0
//   for (let i = 0; i < 16; ++i) {
//     count = ((1 << i) & n) ? count + 1 : count
//   }
//   return count
// }
