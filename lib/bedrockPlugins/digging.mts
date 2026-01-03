import type { BedrockBot } from '../../index.js';
import type { Block } from 'prismarine-block';
import type { Vec3 } from 'vec3';
import { performance } from 'perf_hooks';
// @ts-ignore
import { createDoneTask, createTask } from '../promise_utils.js';

const BlockFaces = {
  BOTTOM: 0,
  TOP: 1,
  NORTH: 2,
  SOUTH: 3,
  WEST: 4,
  EAST: 5,
};

export default function inject(bot: BedrockBot) {
  let swingInterval: ReturnType<typeof setInterval> | null = null;
  let continueBreakInterval: ReturnType<typeof setInterval> | null = null;
  let waitTimeout: ReturnType<typeof setTimeout> | null = null;
  let diggingTask = createDoneTask();

  bot.targetDigBlock = null;
  bot.targetDigFace = null;
  bot.lastDigTime = null;

  async function dig(block: Block, forceLook?: boolean | 'ignore', digFace?: Vec3 | 'auto' | 'raycast'): Promise<void> {
    if (block === null || block === undefined) {
      throw new Error('dig was called with an undefined or null block');
    }

    if (!digFace || typeof digFace === 'function') {
      digFace = 'auto';
    }

    const waitTime = bot.digTime(block);
    if (waitTime === Infinity) {
      throw new Error(`dig time for ${block?.name ?? block} is Infinity`);
    }

    bot.targetDigFace = BlockFaces.TOP; // Default

    if (forceLook !== 'ignore') {
      // Calculate which face to mine based on position
      if (digFace && typeof digFace === 'object' && (digFace.x || digFace.y || digFace.z)) {
        if (digFace.x) {
          bot.targetDigFace = digFace.x > 0 ? BlockFaces.EAST : BlockFaces.WEST;
        } else if (digFace.y) {
          bot.targetDigFace = digFace.y > 0 ? BlockFaces.TOP : BlockFaces.BOTTOM;
        } else if (digFace.z) {
          bot.targetDigFace = digFace.z > 0 ? BlockFaces.SOUTH : BlockFaces.NORTH;
        }
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5).offset(digFace.x * 0.5, digFace.y * 0.5, digFace.z * 0.5), forceLook);
      } else if (digFace === 'raycast') {
        // Use raycast to find visible face
        const delta = block.position.offset(0.5, 0.5, 0.5).minus(bot.entity.position.offset(0, bot.entity.height, 0));
        if (Math.abs(delta.y) > Math.abs(delta.x) && Math.abs(delta.y) > Math.abs(delta.z)) {
          bot.targetDigFace = delta.y > 0 ? BlockFaces.BOTTOM : BlockFaces.TOP;
        } else if (Math.abs(delta.x) > Math.abs(delta.z)) {
          bot.targetDigFace = delta.x > 0 ? BlockFaces.WEST : BlockFaces.EAST;
        } else {
          bot.targetDigFace = delta.z > 0 ? BlockFaces.NORTH : BlockFaces.SOUTH;
        }
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook);
      } else {
        // auto - look at center
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook);
      }
    }

    // Cancel any existing dig
    if (bot.targetDigBlock) bot.stopDigging();

    diggingTask = createTask();
    const pos = block.position;
    const face = bot.targetDigFace;

    bot.targetDigBlock = block;

    // Check if this is an instant break (crops, etc.)
    const isInstantBreak = waitTime <= 50;

    if (isInstantBreak) {
      // For instant breaks, combine start_break + predict_break in same packet
      bot.swingArm('right', true, 'mine');
      bot.swingArm('right', true, 'mine');
      bot.swingArm('right', true, 'mine');
      bot.swingArm('right', true, 'mine');
      bot.swingArm('right', true, 'mine');

      const heldItem = bot.heldItem;
      const itemStackRequest = heldItem
        ? {
            requests: [
              {
                request_id: bot.getNextItemStackRequestId(),
                actions: [
                  {
                    type_id: 'mine_block',
                    hotbar_slot: bot.quickBarSlot ?? 0,
                    predicted_durability: (heldItem.durabilityUsed ?? 0) + 1,
                    network_id: heldItem.stackId ?? 0,
                  },
                ],
                custom_names: [],
                cause: -1,
              },
            ],
          }
        : undefined;

      await bot.sendPlayerAuthInputTransaction(
        {
          block_action: [
            { action: 'start_break', position: { x: pos.x, y: pos.y, z: pos.z }, face: face },
            { action: 'predict_break', position: { x: pos.x, y: pos.y, z: pos.z }, face: face },
          ],
          item_stack_request: itemStackRequest,
        },
        false
      );

      // Update local block state
      const airStateId = bot.registry.blocksByName.air?.defaultState ?? 0;
      bot._updateBlockState(bot.targetDigBlock.position, airStateId);

      // Schedule abort_break after a tick
      waitTimeout = setTimeout(() => finishInstantDigging(pos, face), 50);
    } else {
      // Send start_break for non-instant breaks
      await bot.sendPlayerAuthInputTransaction(
        {
          block_action: [
            {
              action: 'start_break',
              position: { x: pos.x, y: pos.y, z: pos.z },
              face: face,
            },
          ],
        },
        false
      );

      bot.swingArm('right', true, 'mine');

      // Swing arm every 350ms
      swingInterval = setInterval(() => {
        bot.swingArm('right', true, 'mine');
      }, 350);

      // Send continue_break every 50ms (every tick)
      continueBreakInterval = setInterval(async () => {
        if (bot.targetDigBlock) {
          await bot.sendPlayerAuthInputTransaction(
            {
              block_action: [
                {
                  action: 'continue_break',
                  position: { x: pos.x, y: pos.y, z: pos.z },
                  face: face,
                },
              ],
            },
            false
          );
        }
      }, 50);

      // Schedule finish digging
      waitTimeout = setTimeout(() => finishDigging(pos, face), waitTime);
    }

    async function finishInstantDigging(pos: { x: number; y: number; z: number }, face: number) {
      clearTimeout(waitTimeout!);
      waitTimeout = null;

      // Send abort_break after instant break completes
      await bot.sendPlayerAuthInputTransaction(
        {
          block_action: [
            {
              action: 'abort_break',
              position: { x: pos.x, y: pos.y, z: pos.z },
              face: 0,
            },
          ],
        },
        false
      );

      bot.targetDigBlock = null;
      bot.targetDigFace = null;
      bot.lastDigTime = performance.now();
      bot.emit('diggingCompleted', block);
      diggingTask.finish();
    }

    async function finishDigging(pos: { x: number; y: number; z: number }, face: number) {
      clearInterval(swingInterval!);
      clearInterval(continueBreakInterval!);
      clearTimeout(waitTimeout!);
      swingInterval = null;
      continueBreakInterval = null;
      waitTimeout = null;

      if (bot.targetDigBlock) {
        // Send continue_break + predict_break together with item_stack_request for tool durability
        const heldItem = bot.heldItem;
        const itemStackRequest = heldItem
          ? {
              requests: [
                {
                  request_id: bot.getNextItemStackRequestId(),
                  actions: [
                    {
                      type_id: 'mine_block',
                      hotbar_slot: bot.quickBarSlot ?? 0,
                      predicted_durability: (heldItem.durabilityUsed ?? 0) + 1,
                      network_id: heldItem.stackId ?? 0,
                    },
                  ],
                  custom_names: [],
                  cause: -1,
                },
              ],
            }
          : undefined;

        await bot.sendPlayerAuthInputTransaction(
          {
            block_action: [
              { action: 'continue_break', position: pos, face: face },
              { action: 'predict_break', position: pos, face: face },
            ],
            item_stack_request: itemStackRequest,
          },
          false
        );

        // Update local block state - use air block's stateId (not 0!)
        const airStateId = bot.registry.blocksByName.air?.defaultState ?? 0;
        bot._updateBlockState(bot.targetDigBlock.position, airStateId);

        await bot.waitForTicks(3);
        await bot.sendPlayerAuthInputTransaction(
          {
            block_action: [
              {
                action: 'abort_break',
                position: { x: pos.x, y: pos.y, z: pos.z },
                face: 0,
              },
            ],
          },
          false
        );
      }

      bot.targetDigBlock = null;
      bot.targetDigFace = null;
      bot.lastDigTime = performance.now();
    }

    // Listen for block update confirmation
    const eventName = `blockUpdate:${block.position}`;
    bot.on(eventName, onBlockUpdate);

    const currentBlock = block;
    bot.stopDigging = () => {
      if (!bot.targetDigBlock) return;

      bot.removeListener(eventName, onBlockUpdate);
      clearInterval(swingInterval!);
      clearInterval(continueBreakInterval!);
      clearTimeout(waitTimeout!);
      swingInterval = null;
      continueBreakInterval = null;
      waitTimeout = null;

      // Send abort_break
      const abortPos = bot.targetDigBlock.position;
      bot.sendPlayerAuthInputTransaction(
        {
          block_action: [
            {
              action: 'abort_break',
              position: { x: abortPos.x, y: abortPos.y, z: abortPos.z },
              face: bot.targetDigFace ?? 0,
            },
          ],
        },
        false
      );

      const abortedBlock = bot.targetDigBlock;
      bot.targetDigBlock = null;
      bot.targetDigFace = null;
      bot.lastDigTime = performance.now();
      bot.emit('diggingAborted', abortedBlock);
      bot.stopDigging = noop;
      diggingTask.cancel(new Error('Digging aborted'));
    };

    function onBlockUpdate(oldBlock: Block | null, newBlock: Block | null) {
      // Block update received - check if block is now air
      if (newBlock?.type !== 0) return;

      bot.removeListener(eventName, onBlockUpdate);
      clearInterval(swingInterval!);
      clearInterval(continueBreakInterval!);
      clearTimeout(waitTimeout!);
      swingInterval = null;
      continueBreakInterval = null;
      waitTimeout = null;
      bot.targetDigBlock = null;
      bot.targetDigFace = null;
      bot.lastDigTime = performance.now();
      bot.emit('diggingCompleted', newBlock);
      diggingTask.finish();
    }

    await diggingTask.promise;
  }

  bot.on('death', () => {
    bot.removeAllListeners('diggingAborted');
    bot.removeAllListeners('diggingCompleted');
    bot.stopDigging();
  });

  function canDigBlock(block: Block): boolean {
    return block && block.diggable && block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1;
  }

  function digTime(block: Block): number {
    let type = null;
    let enchantments: any[] = [];

    const currentlyHeldItem = bot.heldItem;
    if (currentlyHeldItem) {
      type = currentlyHeldItem.type;
      enchantments = currentlyHeldItem.enchants || [];
    }

    // Append helmet enchantments (Aqua Affinity affects dig speed)
    const headEquipmentSlot = bot.getEquipmentDestSlot?.('head');
    if (headEquipmentSlot !== undefined) {
      const headEquippedItem = bot.inventory?.slots?.[headEquipmentSlot];
      if (headEquippedItem?.enchants) {
        enchantments = enchantments.concat(headEquippedItem.enchants);
      }
    }

    const creative = bot.game?.gameMode === 'creative';
    return block.digTime(type, creative, bot.entity?.isInWater ?? false, !(bot.entity?.onGround ?? true), enchantments, bot.entity?.effects ?? {});
  }

  bot.dig = dig;
  bot.stopDigging = noop;
  bot.canDigBlock = canDigBlock;
  bot.digTime = digTime;
}

function noop(err?: Error) {
  if (err) throw err;
}
