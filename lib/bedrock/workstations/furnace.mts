/**
 * Furnace Workstation - Smelting operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - furnace_ingredient: slot 0
 * - furnace_fuel: slot 1
 * - furnace_output: slot 2
 */

import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../../index.js';
import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds } from '../item-stack-actions.mts';
import { findItemInAllSlots } from '../crafting-core.mts';

// ============================================================================
// Constants
// ============================================================================

export const FurnaceSlots = {
  INGREDIENT: 0,
  FUEL: 1,
  OUTPUT: 2,
} as const;

// ============================================================================
// Furnace Interface
// ============================================================================

export interface Furnace {
  window: Window;
  /** Put item in ingredient slot */
  putIngredient: (itemType: number | string, metadata: number | null, count: number) => Promise<void>;
  /** Put item in fuel slot */
  putFuel: (itemType: number | string, metadata: number | null, count: number) => Promise<void>;
  /** Take item from ingredient slot */
  takeInput: () => Promise<Item | null>;
  /** Take item from fuel slot */
  takeFuel: () => Promise<Item | null>;
  /** Take item from output slot */
  takeOutput: () => Promise<Item | null>;
  /** Get current ingredient item */
  inputItem: () => Item | null;
  /** Get current fuel item */
  fuelItem: () => Item | null;
  /** Get current output item */
  outputItem: () => Item | null;
  /** Fuel progress (0-1) - percentage of fuel remaining */
  fuel: number;
  /** Smelting progress (0-1) - percentage of current item smelted */
  progress: number;
  /** Close the furnace */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open a furnace block and return interface for smelting
 */
export async function openFurnace(bot: BedrockBot, furnaceBlock: Block): Promise<Furnace> {
  const window = await bot.openBlock(furnaceBlock);
  bot.logger.debug(`Opened furnace window: ${window?.id}`);

  // Track fuel and progress from container_set_data packet
  let fuelProgress = 0;
  let smeltProgress = 0;

  // Listen for container data updates (furnace progress bars)
  // Bedrock sends container_set_data with property IDs:
  // 0 = furnace tick count (smelting progress)
  // 1 = furnace lit time (fuel remaining)
  // 2 = furnace lit duration (max fuel time)
  // 3 = furnace tick count total (max smelting time)
  const dataHandler = (packet: any) => {
    if (packet.window_id !== window.id) return;

    // Property 0/3 = smelting progress
    // Property 1/2 = fuel progress
    // Values are raw tick counts, convert to 0-1 range
    if (packet.property === 0 || packet.property === 3) {
      // Smelting progress - 200 ticks = full smelt
      smeltProgress = Math.min(1, packet.value / 200);
    } else if (packet.property === 1 || packet.property === 2) {
      // Fuel progress - depends on fuel type
      if (packet.property === 1 && packet.value > 0) {
        fuelProgress = packet.value / 1600; // Coal = 1600 ticks
      }
    }
  };
  bot._client.on('container_set_data', dataHandler);

  const furnace: Furnace = {
    window,

    get fuel() { return fuelProgress; },
    get progress() { return smeltProgress; },

    async putIngredient(itemType: number | string, metadata: number | null, count: number): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Item ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions()
          .place(count, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId }, { containerId: ContainerIds.FURNACE_INGREDIENT, slot: FurnaceSlots.INGREDIENT, stackId: 0 })
          .build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to put ingredient in furnace');
      }
    },

    async putFuel(itemType: number | string, metadata: number | null, count: number): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Fuel ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(
        bot,
        requestId,
        actions().place(count, { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId }, { containerId: ContainerIds.FURNACE_FUEL, slot: FurnaceSlots.FUEL, stackId: 0 }).build()
      );

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to put fuel in furnace');
      }
    },

    async takeInput(): Promise<Item | null> {
      const inputItem = window.slots[FurnaceSlots.INGREDIENT];
      if (!inputItem) return null;

      const stackId = getStackId(inputItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(bot, requestId, actions().takeToCursor(inputItem.count, { containerId: ContainerIds.FURNACE_INGREDIENT, slot: FurnaceSlots.INGREDIENT, stackId }).build());

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to take input from furnace');
      }

      await bot.putAway(0);
      return inputItem;
    },

    async takeFuel(): Promise<Item | null> {
      const fuelItem = window.slots[FurnaceSlots.FUEL];
      if (!fuelItem) return null;

      const stackId = getStackId(fuelItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(bot, requestId, actions().takeToCursor(fuelItem.count, { containerId: ContainerIds.FURNACE_FUEL, slot: FurnaceSlots.FUEL, stackId }).build());

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to take fuel from furnace');
      }

      await bot.putAway(0);
      return fuelItem;
    },

    async takeOutput(): Promise<Item | null> {
      const outputItem = window.slots[FurnaceSlots.OUTPUT];
      if (!outputItem) return null;

      const stackId = getStackId(outputItem);
      const requestId = getNextItemStackRequestId();

      sendRequest(bot, requestId, actions().takeToCursor(outputItem.count, { containerId: ContainerIds.FURNACE_OUTPUT, slot: FurnaceSlots.OUTPUT, stackId }).build());

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Failed to take output from furnace');
      }

      await bot.putAway(0);
      return outputItem;
    },

    inputItem(): Item | null {
      return window.slots[FurnaceSlots.INGREDIENT] || null;
    },

    fuelItem(): Item | null {
      return window.slots[FurnaceSlots.FUEL] || null;
    },

    outputItem(): Item | null {
      return window.slots[FurnaceSlots.OUTPUT] || null;
    },

    close() {
      bot._client.removeListener('container_set_data', dataHandler);
      bot.closeWindow(window);
    },
  };

  return furnace;
}
