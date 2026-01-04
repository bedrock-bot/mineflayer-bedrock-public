/**
 * Slot Mapping - Container ID and slot index mapping utilities for Bedrock protocol
 *
 * Handles the translation between:
 * - Bedrock window_id strings ("inventory", "armor", "hotbar", etc.)
 * - Prismarine-windows slot indices (0-45 for player inventory)
 * - Bedrock container IDs for item_stack_request actions
 */

import type { Window } from 'prismarine-windows';
import type { BedrockBot } from '../../index.js';
import { ContainerIds, type SlotLocation } from './item-stack-actions.mts';

// ============================================================================
// Slot Index Constants
// ============================================================================

export const SlotRanges = {
  // Bedrock slot layout: 0-8 hotbar, 9-35 inventory, 36-39 armor, 45 offhand
  HOTBAR_START: 0,
  HOTBAR_END: 8,
  INVENTORY_START: 9,
  INVENTORY_END: 35,
  ARMOR_START: 36,
  ARMOR_END: 39,
  OFFHAND: 45,

  // Hotbar count
  HOTBAR_COUNT: 9,

  // Total slots in player inventory
  TOTAL_SLOTS: 46,
} as const;

// ============================================================================
// Window ID to Slot Index Mapping
// ============================================================================

/**
 * Map Bedrock window_id and slot to prismarine-windows slot index
 *
 * @param windowId - Bedrock window ID ("inventory", "armor", "hotbar", etc.)
 * @param slot - Slot index within that window
 * @returns Prismarine-windows slot index
 */
export function getSlotIndex(windowId: protocolTypes.WindowID, slot: number): number {
  switch (windowId) {
    case 'inventory':
      return slot;
    case 'armor':
      return SlotRanges.ARMOR_START + slot; // armor slots 36-39 (head, torso, legs, feet)
    case 'offhand':
      return SlotRanges.OFFHAND + slot; // offhand at slot 45 (Java compatibility)
    case 'hotbar':
      return slot;
    default:
      return slot;
  }
}

// ============================================================================
// Window ID to Window Object Mapping
// ============================================================================

/**
 * Map Bedrock window_id to Window object
 *
 * @param bot - The bot instance
 * @param windowId - Bedrock window ID
 * @returns Window object or null for UI windows
 */
export function getWindow(bot: BedrockBot, windowId: protocolTypes.WindowID): Window | null {
  if (windowId === 'inventory' || windowId === 'armor' || windowId === 'offhand' || windowId === 'hotbar' || windowId === 'fixed_inventory') {
    return bot.inventory;
  } else if (windowId === 'ui') {
    return null;
  } else {
    // For container windows (chest, furnace, etc.), use currentWindow
    // Returns null if no container is currently open
    return bot.currentWindow;
  }
}

// ============================================================================
// Slot Index to Container ID Mapping
// ============================================================================

/**
 * Container location with ID and slot
 */
export interface ContainerLocation {
  containerId: string;
  slot: number;
}

/**
 * Get container ID for cursor-based operations (take/place through cursor).
 * Based on packet captures:
 * - Hotbar slots (0-8) use "hotbar" container
 * - Main inventory slots (9-35) use "inventory" container
 * - Armor slots (36-39) use "armor" container
 * - Offhand (45) uses "offhand" container
 *
 * @param slotIndex - Prismarine-windows slot index
 * @returns Container location with ID and slot
 */
export function getContainerForCursorOp(slotIndex: number): ContainerLocation {
  if (slotIndex >= SlotRanges.HOTBAR_START && slotIndex <= SlotRanges.HOTBAR_END) {
    return { containerId: ContainerIds.HOTBAR, slot: slotIndex };
  } else if (slotIndex >= SlotRanges.INVENTORY_START && slotIndex <= SlotRanges.INVENTORY_END) {
    return { containerId: ContainerIds.INVENTORY, slot: slotIndex };
  } else if (slotIndex >= SlotRanges.ARMOR_START && slotIndex <= SlotRanges.ARMOR_END) {
    return { containerId: ContainerIds.ARMOR, slot: slotIndex - SlotRanges.ARMOR_START };
  } else if (slotIndex === SlotRanges.OFFHAND) {
    return { containerId: ContainerIds.OFFHAND, slot: 1 };
  } else {
    throw new Error(`Invalid slot index for cursor op: ${slotIndex}`);
  }
}

/**
 * Get container ID from slot index, considering open container windows.
 *
 * @param slotIndex - Prismarine-windows slot index
 * @param window - Optional window object (for container slot detection)
 * @returns Container location with ID and slot
 */
export function getContainerFromSlot(slotIndex: number, window?: Window): ContainerLocation {
  // If we have a container window open, check if slot is in container section
  // Only apply container logic if inventoryStart > 9 (player inventory has inventoryStart=9)
  // Container windows like chests have inventoryStart >= 27
  if (window && (window as any).inventoryStart !== undefined) {
    const inventoryStart = (window as any).inventoryStart as number;

    // Player inventory has inventoryStart=9 (separating hotbar from main inventory)
    // Container windows have inventoryStart >= 27 (chest) or more
    // Only treat as container window if inventoryStart is large enough to indicate a container
    if (inventoryStart > SlotRanges.INVENTORY_END) {
      if (slotIndex < inventoryStart) {
        // Container slot (e.g., chest slots 0-26)
        return { containerId: ContainerIds.CONTAINER, slot: slotIndex };
      }

      // Adjust slot index for player inventory section within container window
      // Window slots 27-62 map to player inventory
      const playerSlot = slotIndex - inventoryStart;
      if (playerSlot >= SlotRanges.HOTBAR_START && playerSlot <= SlotRanges.HOTBAR_END) {
        return { containerId: ContainerIds.HOTBAR, slot: playerSlot };
      } else if (playerSlot >= SlotRanges.INVENTORY_START && playerSlot <= SlotRanges.INVENTORY_END) {
        return { containerId: ContainerIds.INVENTORY, slot: playerSlot };
      }
    }
  }

  // Player inventory layout (Java compatible):
  // 0-8: hotbar (hotbar slots 0-8)
  // 9-35: main inventory (inventory slots 9-35)
  // 36-39: armor (armor slots 0-3: head, torso, legs, feet)
  // 45: offhand (offhand slot 0)

  if (slotIndex >= SlotRanges.HOTBAR_START && slotIndex <= SlotRanges.HOTBAR_END) {
    return { containerId: ContainerIds.HOTBAR, slot: slotIndex };
  } else if (slotIndex >= SlotRanges.INVENTORY_START && slotIndex <= SlotRanges.INVENTORY_END) {
    return { containerId: ContainerIds.INVENTORY, slot: slotIndex };
  } else if (slotIndex >= SlotRanges.ARMOR_START && slotIndex <= SlotRanges.ARMOR_END) {
    return { containerId: ContainerIds.ARMOR, slot: slotIndex - SlotRanges.ARMOR_START };
  } else if (slotIndex === SlotRanges.OFFHAND) {
    // Offhand uses slot 1 in item_stack_request, not 0
    return { containerId: ContainerIds.OFFHAND, slot: 1 };
  } else {
    throw new Error(`Invalid slot index: ${slotIndex}`);
  }
}

/**
 * Convert slot index to SlotLocation with stack ID from item
 */
export function slotToLocation(slotIndex: number, stackId: number, window?: Window): SlotLocation {
  const container = getContainerFromSlot(slotIndex, window);
  return {
    containerId: container.containerId,
    slot: container.slot,
    stackId,
  };
}

// ============================================================================
// Inventory Section Helpers
// ============================================================================

/**
 * Check if slot is in hotbar
 */
export function isHotbarSlot(slotIndex: number): boolean {
  return slotIndex >= SlotRanges.HOTBAR_START && slotIndex <= SlotRanges.HOTBAR_END;
}

/**
 * Check if slot is in main inventory
 */
export function isInventorySlot(slotIndex: number): boolean {
  return slotIndex >= SlotRanges.INVENTORY_START && slotIndex <= SlotRanges.INVENTORY_END;
}

/**
 * Check if slot is armor
 */
export function isArmorSlot(slotIndex: number): boolean {
  return slotIndex >= SlotRanges.ARMOR_START && slotIndex <= SlotRanges.ARMOR_END;
}

/**
 * Check if slot is offhand
 */
export function isOffhandSlot(slotIndex: number): boolean {
  return slotIndex === SlotRanges.OFFHAND;
}

/**
 * Get armor slot type (head, torso, legs, feet)
 */
export function getArmorType(slotIndex: number): 'head' | 'torso' | 'legs' | 'feet' | null {
  if (!isArmorSlot(slotIndex)) return null;
  const armorSlot = slotIndex - SlotRanges.ARMOR_START;
  const types: ('head' | 'torso' | 'legs' | 'feet')[] = ['head', 'torso', 'legs', 'feet'];
  return types[armorSlot];
}

/**
 * Get slot index for armor type
 */
export function getArmorSlot(type: 'head' | 'torso' | 'legs' | 'feet'): number {
  const offsets = { head: 0, torso: 1, legs: 2, feet: 3 };
  return SlotRanges.ARMOR_START + offsets[type];
}
