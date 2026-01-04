/**
 * Anvil Workstation - Repair and rename operations for Bedrock protocol
 *
 * Container IDs from packet captures:
 * - anvil_input: slot 1
 * - anvil_material: slot 2
 *
 * Uses 'optional' action type for rename operations
 */

import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../../index.js';
import { actions, getNextItemStackRequestId, getStackId, sendRequest, waitForResponse, ContainerIds, cursor } from '../item-stack-actions.mts';
import { findItemInAllSlots, CraftingSlots } from '../crafting-core.mts';
import { twoStepTransfer } from '../container.mts';

// ============================================================================
// Constants
// ============================================================================

export const AnvilSlots = {
  INPUT: 1,
  MATERIAL: 2,
} as const;

// ============================================================================
// Anvil Interface
// ============================================================================

export interface Anvil {
  window: Window;
  /** Rename item */
  rename: (newName: string) => Promise<void>;
  /** Combine items (repair) */
  combine: () => Promise<void>;
  /** Put item in first slot */
  putTarget: (itemType: number | string, metadata: number | null) => Promise<void>;
  /** Put item in material slot */
  putMaterial: (itemType: number | string, metadata: number | null, count: number) => Promise<void>;
  /** Take result */
  takeResult: () => Promise<Item | null>;
  /** Close the anvil */
  close: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Open an anvil and return interface for repair/rename
 *
 * Note: Unlike other workstations, anvil in Bedrock doesn't require waiting for
 * container_open. The client opens the anvil UI locally and directly sends
 * item_stack_requests to anvil_input/anvil_material containers.
 */
export async function openAnvil(bot: BedrockBot, anvilBlock: Block): Promise<Anvil> {
  // Send the interaction packet but don't wait for container_open
  // Anvil is a "screen" that opens client-side without server confirmation
  await bot.lookAt(anvilBlock.position.offset(0.5, 0.5, 0.5), true);

  // Send player_action: start_item_use_on to signal intent
  const entityId = bot.entity.id;
  const face = 1; // Click on top of anvil
  bot._client.write('player_action', {
    runtime_entity_id: entityId,
    action: 'start_item_use_on',
    position: {
      x: anvilBlock.position.x,
      y: anvilBlock.position.y,
      z: anvilBlock.position.z,
    },
    result_position: {
      x: anvilBlock.position.x,
      y: anvilBlock.position.y + 1,
      z: anvilBlock.position.z,
    },
    face: face,
  });

  // Send inventory_transaction to click on the anvil
  bot._client.write('inventory_transaction', {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      actions: [],
      transaction_data: {
        action_type: 'click_block',
        trigger_type: 'player_input',
        block_position: anvilBlock.position,
        face: face,
        hotbar_slot: bot.quickBarSlot ?? 0,
        held_item: { network_id: 0 },
        player_pos: {
          x: bot.entity.position.x,
          y: bot.entity.position.y + 1.62,
          z: bot.entity.position.z,
        },
        click_pos: { x: 0.5, y: 0.5, z: 0.5 },
        block_runtime_id: (anvilBlock as any).stateId >>> 0,
        client_prediction: 'success',
      },
    },
  });

  // Wait a moment for the server to acknowledge
  await new Promise(r => setTimeout(r, 100));

  // Create a minimal window object for compatibility
  const windowLoader = await import('prismarine-windows');
  const windows = (windowLoader.default as any)(bot.registry);
  const window = windows.createWindow(255, 'anvil', 'Anvil', 3); // 3 slots for anvil

  bot.logger.debug(`Opened anvil (no container_open needed)`);

  // Track stack IDs for items placed in anvil
  let inputStackId = 0;
  let materialStackId = 0;

  return {
    window,

    async rename(newName: string): Promise<void> {
      // Use the tracked inputStackId from putTarget, or try to get it from window slots
      const currentInputStackId = inputStackId || (window.slots[AnvilSlots.INPUT] ? getStackId(window.slots[AnvilSlots.INPUT]!) : 0);

      // Find an empty slot for output
      const emptySlot = bot.inventory.slots.findIndex(
        (s, i) => i >= bot.inventory.inventoryStart && i <= bot.inventory.inventoryEnd && !s
      );
      const destSlot = emptySlot !== -1 ? emptySlot : 0;

      const requestId = getNextItemStackRequestId();

      // Anvil rename uses 'optional' action + consume + place pattern
      // Based on packet capture: {"type":"optional"},{"type":"consume","src":"anvil_input:1",...},{"type":"place","src":"creative_output:50",...,"dst":"hotbar_and_inventory:9",...}
      const actionList: any[] = [
        {
          type_id: 'optional',
          filtered_string_index: 0,
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.ANVIL_INPUT },
            slot: AnvilSlots.INPUT,
            stack_id: currentInputStackId,
          },
        },
        {
          type_id: 'place',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.CREATIVE_OUTPUT },
            slot: CraftingSlots.CREATIVE_OUTPUT_SLOT,
            stack_id: requestId,
          },
          destination: {
            slot_type: { container_id: ContainerIds.HOTBAR_AND_INVENTORY },
            slot: destSlot,
            stack_id: 0,
          },
        },
      ];

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: requestId,
            actions: actionList,
            custom_names: [newName],
            cause: -1,
          },
        ],
      });

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Anvil rename failed');
      }
    },

    async combine(): Promise<void> {
      // Get stack IDs from items in anvil slots
      const inputItem = window.slots[AnvilSlots.INPUT];
      const materialItem = window.slots[AnvilSlots.MATERIAL];
      const inputStackId = inputItem ? getStackId(inputItem) : 0;
      const materialStackId = materialItem ? getStackId(materialItem) : 0;

      // Find an empty slot for output
      const emptySlot = bot.inventory.slots.findIndex(
        (s, i) => i >= bot.inventory.inventoryStart && i <= bot.inventory.inventoryEnd && !s
      );
      const destSlot = emptySlot !== -1 ? emptySlot : 0;

      const requestId = getNextItemStackRequestId();

      // Based on packet capture: optional + consume material + consume input + place
      const actionList: any[] = [
        {
          type_id: 'optional',
          filtered_string_index: 0,
        },
        {
          type_id: 'consume',
          count: materialItem?.count || 1,
          source: {
            slot_type: { container_id: ContainerIds.ANVIL_MATERIAL },
            slot: AnvilSlots.MATERIAL,
            stack_id: materialStackId,
          },
        },
        {
          type_id: 'consume',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.ANVIL_INPUT },
            slot: AnvilSlots.INPUT,
            stack_id: inputStackId,
          },
        },
        {
          type_id: 'place',
          count: 1,
          source: {
            slot_type: { container_id: ContainerIds.CREATIVE_OUTPUT },
            slot: CraftingSlots.CREATIVE_OUTPUT_SLOT,
            stack_id: requestId,
          },
          destination: {
            slot_type: { container_id: ContainerIds.HOTBAR_AND_INVENTORY },
            slot: destSlot,
            stack_id: 0,
          },
        },
      ];

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: requestId,
            actions: actionList,
            custom_names: [''],
            cause: -1,
          },
        ],
      });

      if (!(await waitForResponse(bot, requestId))) {
        throw new Error('Anvil combine failed');
      }
    },

    async putTarget(itemType: number | string, metadata: number | null): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Item ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);

      // Use two-step cursor transfer for anvil (like stonecutter)
      const result = await twoStepTransfer(
        bot,
        { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId },
        { containerId: ContainerIds.ANVIL_INPUT, slot: AnvilSlots.INPUT, stackId: 0 },
        1
      );

      if (!result.success) {
        throw new Error('Failed to put item in anvil');
      }

      // Track the stack ID for later use in rename
      inputStackId = result.cursorStackId;
    },

    async putMaterial(itemType: number | string, metadata: number | null, count: number): Promise<void> {
      const foundItem = findItemInAllSlots(bot, itemType, metadata);
      if (!foundItem) {
        throw new Error(`Material ${itemType} not found in inventory`);
      }

      const slotIndex = foundItem.slot;
      const stackId = getStackId(foundItem);

      // Use two-step cursor transfer for anvil
      const result = await twoStepTransfer(
        bot,
        { containerId: ContainerIds.HOTBAR_AND_INVENTORY, slot: slotIndex, stackId },
        { containerId: ContainerIds.ANVIL_MATERIAL, slot: AnvilSlots.MATERIAL, stackId: 0 },
        count
      );

      if (!result.success) {
        throw new Error('Failed to put material in anvil');
      }

      // Track the stack ID for later use
      materialStackId = result.cursorStackId;
    },

    async takeResult(): Promise<Item | null> {
      // Result is taken via combine/rename actions
      return null;
    },

    close() {
      bot.closeWindow(window);
    },
  };
}
