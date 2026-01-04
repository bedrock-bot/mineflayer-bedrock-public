/**
 * Container Operations - Unified transfer utilities for Bedrock protocol
 *
 * Provides:
 * - Generic transferItems() function that handles both deposit and withdraw
 * - depositToContainer() - Move items from player inventory to container
 * - withdrawFromContainer() - Move items from container to player inventory
 *
 * Replaces ~300 lines of duplicated code in inventory.mts
 */

import type { Window } from 'prismarine-windows';
import type { Item } from 'prismarine-item';
import type { BedrockBot } from '../../index.js';
import type { protocolTypes } from '../../bedrock-types.js';

import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds, cursor, type SlotLocation } from './item-stack-actions.mts';
import { getContainerFromSlot, SlotRanges } from './slot-mapping.mts';

// ============================================================================
// Transfer Configuration
// ============================================================================

/**
 * Configuration for generic transfer operation
 */
export interface TransferConfig {
  bot: BedrockBot;
  sourceWindow: Window;
  sourceContainerId: string;
  sourceStart: number;
  sourceEnd: number;
  destWindow: Window;
  destContainerId: string;
  destStart: number;
  destEnd: number;
  itemType: number;
  metadata: number | null;
  nbt?: object | null;
  count: number | null;
}

// ============================================================================
// Generic Transfer Function
// ============================================================================

/**
 * Transfer items between windows/containers
 *
 * This is the core transfer function that unifies deposit and withdraw operations.
 * Uses two-step cursor-based transfer (take to cursor, place from cursor).
 *
 * @param config - Transfer configuration
 * @returns Number of items transferred
 */
export async function transferItems(config: TransferConfig): Promise<number> {
  const { bot, sourceWindow, sourceContainerId, sourceStart, sourceEnd, destWindow, destContainerId, destStart, destEnd, itemType, metadata, nbt, count } = config;

  const totalToTransfer = count ?? 64;
  let transferred = 0;
  const maxStackSize = bot.registry.itemsArray.find((x: any) => x.id === itemType)?.stackSize ?? 64;

  while (transferred < totalToTransfer) {
    // Find source item (re-find each iteration as slots change)
    const sourceItem = sourceWindow.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt);
    if (!sourceItem) {
      if (transferred === 0) {
        const mcDataEntry = bot.registry.itemsArray.find((x: any) => x.id === itemType);
        throw new Error(`Can't find ${mcDataEntry?.name || itemType} in source`);
      }
      break; // No more items to transfer
    }

    // Find destination slot
    let destSlot: number | null = null;
    let destStackId = 0;
    let destCurrentCount = 0;

    // First try to stack with existing items
    const existingItem = destWindow.findItemRange(destStart, destEnd, itemType, metadata, true, nbt);
    if (existingItem) {
      destSlot = existingItem.slot;
      destStackId = getStackId(existingItem);
      destCurrentCount = existingItem.count;
    } else {
      destSlot = destWindow.firstEmptySlotRange(destStart, destEnd);
      destCurrentCount = 0;
    }

    if (destSlot === null) {
      if (transferred === 0) {
        throw new Error('Destination is full');
      }
      break; // Destination full, but we transferred some
    }

    // Calculate how many items to transfer in this batch
    const availableInDest = maxStackSize - destCurrentCount;
    const remainingToTransfer = totalToTransfer - transferred;
    const availableInSource = sourceItem.count;
    const transferCount = Math.min(availableInDest, remainingToTransfer, availableInSource);

    if (transferCount <= 0) {
      // Destination stack is full, find another slot
      destSlot = destWindow.firstEmptySlotRange(destStart, destEnd);
      if (destSlot === null) {
        break; // Destination full
      }
      destStackId = 0;
      destCurrentCount = 0;
      continue;
    }

    const stackId = getStackId(sourceItem);

    // Determine source slot info based on container type
    let sourceSlot: SlotLocation;
    if (sourceContainerId === ContainerIds.CONTAINER) {
      sourceSlot = { containerId: ContainerIds.CONTAINER, slot: sourceItem.slot, stackId };
    } else {
      // Player inventory - use proper container mapping
      const mapped = getContainerFromSlot(sourceItem.slot, sourceWindow);
      sourceSlot = { containerId: mapped.containerId, slot: mapped.slot, stackId };
    }

    // Step 1: Take items to cursor
    const takeRequestId = getNextItemStackRequestId();
    let cursorStackId = stackId;

    // Capture cursor stack ID from response
    const takeResponseHandler = (packet: protocolTypes.packet_item_stack_response) => {
      for (const response of packet.responses) {
        if (response.request_id === takeRequestId && response.status === 'ok') {
          for (const container of response.containers || []) {
            if (container.slot_type?.container_id === 'cursor' && container.slots?.length > 0) {
              cursorStackId = container.slots[0].item_stack_id;
            }
          }
        }
      }
    };
    bot._client.on('item_stack_response', takeResponseHandler);

    sendRequest(bot, takeRequestId, actions().takeToCursor(transferCount, sourceSlot).build());

    let success = await waitForResponse(bot, takeRequestId);
    bot._client.removeListener('item_stack_response', takeResponseHandler);

    if (!success) {
      throw new Error('Transfer failed - take rejected');
    }

    // Step 2: Place items from cursor to destination
    const placeRequestId = getNextItemStackRequestId();

    // Determine destination slot info
    let destSlotInfo: SlotLocation;
    if (destContainerId === ContainerIds.CONTAINER) {
      destSlotInfo = { containerId: ContainerIds.CONTAINER, slot: destSlot, stackId: destStackId };
    } else {
      // Player inventory - use proper container mapping
      const mapped = getContainerFromSlot(destSlot, destWindow);
      destSlotInfo = { containerId: mapped.containerId, slot: mapped.slot, stackId: destStackId };
    }

    sendRequest(bot, placeRequestId, actions().placeFromCursor(transferCount, cursorStackId, destSlotInfo).build());

    success = await waitForResponse(bot, placeRequestId);

    if (!success) {
      throw new Error('Transfer failed - place rejected');
    }

    transferred += transferCount;

    // Create new item in destination slot if needed
    // (item_stack_response doesn't know item type, so we create it manually)
    const existingDestItem = destWindow.slots[destSlot];
    if (!existingDestItem) {
      const newItem = Object.assign(Object.create(Object.getPrototypeOf(sourceItem)), sourceItem);
      newItem.count = transferCount;
      newItem.slot = destSlot;
      (newItem as any).stackId = destStackId;
      destWindow.updateSlot(destSlot, newItem);
    }
  }

  return transferred;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Deposit items from player inventory to container
 */
export async function depositToContainer(
  bot: BedrockBot,
  containerWindow: Window,
  itemType: number,
  metadata: number | null,
  count: number | null,
  containerSlots: number,
  nbt?: object | null
): Promise<number> {
  return transferItems({
    bot,
    sourceWindow: bot.inventory,
    sourceContainerId: ContainerIds.HOTBAR_AND_INVENTORY,
    sourceStart: 0,
    sourceEnd: SlotRanges.INVENTORY_END,
    destWindow: containerWindow,
    destContainerId: ContainerIds.CONTAINER,
    destStart: 0,
    destEnd: containerSlots - 1,
    itemType,
    metadata,
    nbt,
    count,
  });
}

/**
 * Withdraw items from container to player inventory
 */
export async function withdrawFromContainer(
  bot: BedrockBot,
  containerWindow: Window,
  itemType: number,
  metadata: number | null,
  count: number | null,
  containerSlots: number,
  nbt?: object | null
): Promise<number> {
  return transferItems({
    bot,
    sourceWindow: containerWindow,
    sourceContainerId: ContainerIds.CONTAINER,
    sourceStart: 0,
    sourceEnd: containerSlots - 1,
    destWindow: bot.inventory,
    destContainerId: ContainerIds.HOTBAR_AND_INVENTORY,
    destStart: 0,
    destEnd: SlotRanges.INVENTORY_END,
    itemType,
    metadata,
    nbt,
    count,
  });
}

// ============================================================================
// Two-Step Transfer Helper
// ============================================================================

/**
 * Perform a two-step transfer through cursor
 * Step 1: Take from source to cursor
 * Step 2: Place from cursor to destination
 *
 * This is useful for single-item transfers where you need cursor stack ID tracking.
 *
 * @returns The cursor stack ID after the take operation
 */
export async function twoStepTransfer(bot: BedrockBot, source: SlotLocation, destination: SlotLocation, count: number): Promise<{ success: boolean; cursorStackId: number }> {
  // Step 1: Take to cursor
  const takeRequestId = getNextItemStackRequestId();
  let cursorStackId = source.stackId;

  const takeResponseHandler = (packet: protocolTypes.packet_item_stack_response) => {
    for (const response of packet.responses) {
      if (response.request_id === takeRequestId && response.status === 'ok') {
        for (const container of response.containers || []) {
          if (container.slot_type?.container_id === 'cursor' && container.slots?.length > 0) {
            cursorStackId = container.slots[0].item_stack_id;
          }
        }
      }
    }
  };
  bot._client.on('item_stack_response', takeResponseHandler);

  sendRequest(bot, takeRequestId, actions().takeToCursor(count, source).build());

  let success = await waitForResponse(bot, takeRequestId);
  bot._client.removeListener('item_stack_response', takeResponseHandler);

  if (!success) {
    return { success: false, cursorStackId: 0 };
  }

  // Step 2: Place from cursor
  const placeRequestId = getNextItemStackRequestId();

  sendRequest(bot, placeRequestId, actions().placeFromCursor(count, cursorStackId, destination).build());

  success = await waitForResponse(bot, placeRequestId);

  return { success, cursorStackId };
}
