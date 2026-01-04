/**
 * Chest Plugin - Container opening convenience methods for Bedrock
 *
 * Provides bot.openContainer, bot.openChest, bot.openDispenser aliases
 * that wrap bot.openBlock/bot.openEntity with container type validation.
 */

import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../index.js';
import { Vec3 } from 'vec3';

// Container block types that can be opened
const CONTAINER_BLOCK_NAMES = [
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'dispenser',
  'dropper',
  'hopper',
  // Shulker boxes (all colors)
  'shulker_box',
  'white_shulker_box',
  'orange_shulker_box',
  'magenta_shulker_box',
  'light_blue_shulker_box',
  'yellow_shulker_box',
  'lime_shulker_box',
  'pink_shulker_box',
  'gray_shulker_box',
  'light_gray_shulker_box',
  'cyan_shulker_box',
  'purple_shulker_box',
  'blue_shulker_box',
  'brown_shulker_box',
  'green_shulker_box',
  'red_shulker_box',
  'black_shulker_box',
  'undyed_shulker_box',
];

// Window types that are valid containers
const CONTAINER_WINDOW_TYPES = [
  'minecraft:generic',
  'minecraft:chest',
  'minecraft:dispenser',
  'minecraft:ender_chest',
  'minecraft:shulker_box',
  'minecraft:hopper',
  'minecraft:container',
  'minecraft:dropper',
  'minecraft:trapped_chest',
  'minecraft:barrel',
  'minecraft:generic_9x1',
  'minecraft:generic_9x2',
  'minecraft:generic_9x3',
  'minecraft:generic_9x4',
  'minecraft:generic_9x5',
  'minecraft:generic_9x6',
];

function isContainerBlock(block: Block): boolean {
  return CONTAINER_BLOCK_NAMES.some((name) => block.name.includes(name));
}

function isContainerWindow(window: Window): boolean {
  return CONTAINER_WINDOW_TYPES.some((type) => window.type.startsWith(type));
}

export default function inject(bot: BedrockBot) {
  /**
   * Open a container block or entity.
   *
   * @param containerToOpen - Block or Entity to open
   * @param direction - Direction to face when opening (default: up)
   * @param cursorPos - Cursor position on block face (default: center)
   * @returns Window for the opened container
   */
  async function openContainer(containerToOpen: Block | Entity, direction?: Vec3, cursorPos?: Vec3): Promise<Window> {
    direction = direction ?? new Vec3(0, 1, 0);
    cursorPos = cursorPos ?? new Vec3(0.5, 0.5, 0.5);

    let window: Window;

    if (containerToOpen.constructor.name === 'Block') {
      const block = containerToOpen as Block;

      if (!isContainerBlock(block)) {
        throw new Error(`Block '${block.name}' is not a container`);
      }

      window = await bot.openBlock(block, direction, cursorPos);
    } else if (containerToOpen.constructor.name === 'Entity') {
      const entity = containerToOpen as Entity;
      window = await bot.openEntity(entity);
    } else {
      throw new Error('containerToOpen must be a Block or Entity');
    }

    if (!isContainerWindow(window)) {
      throw new Error(`Opened window type '${window.type}' is not a container`);
    }

    return window;
  }

  // Expose API
  bot.openContainer = openContainer;
  bot.openChest = openContainer;
  bot.openDispenser = openContainer;
}
