import type { BedrockBot, EquipmentDestination } from '../../index.js';
import itemLoader, { type Item } from 'prismarine-item';
import assert from 'assert';

// In Bedrock Edition, hotbar is slots 0-8 in the inventory window
const QUICK_BAR_START = 0;
const QUICK_BAR_COUNT = 9;

// Armor slot mappings (Java compatible for API consistency)
// Bedrock armor container has 4 slots (0-3): head, torso, legs, feet
// We use Java-compatible indices for prismarine-windows compatibility
const armorSlots: Record<string, number> = {
  head: 36, // armor slot 0
  torso: 37, // armor slot 1
  legs: 38, // armor slot 2
  feet: 39, // armor slot 3
  'off-hand': 45, // offhand slot (Java compatible)
};

export default function inject(bot: BedrockBot) {
  const Item = (itemLoader as any)(bot.registry) as typeof Item;

  async function equip(item: Item | number, destination: EquipmentDestination | null): Promise<void> {
    // Convert item ID to item object if needed
    if (typeof item === 'number') {
      item = bot.inventory.findInventoryItem(item);
    }
    if (item == null || typeof item !== 'object') {
      throw new Error('Invalid item object in equip (item is null or typeof item is not object)');
    }

    // Default to hand if no destination specified
    if (!destination || destination === null) {
      destination = 'hand';
    }

    const sourceSlot = item.slot;
    let destSlot = getDestSlot(destination);

    // Already in correct slot
    if (sourceSlot === destSlot) {
      return;
    }

    // Equipping armor or offhand - just move directly
    if (destination !== 'hand') {
      await bot.moveSlotItem(sourceSlot, destSlot);
      return;
    }

    // Equipping to hand - check if item is already in hotbar
    if (sourceSlot >= QUICK_BAR_START && sourceSlot < QUICK_BAR_START + QUICK_BAR_COUNT) {
      // Item is in hotbar, just change selection
      bot.setQuickBarSlot(sourceSlot - QUICK_BAR_START);
      return;
    }

    // Item is in inventory, need to move to hotbar
    // Find empty hotbar slot
    destSlot = bot.inventory.firstEmptySlotRange(QUICK_BAR_START, QUICK_BAR_START + QUICK_BAR_COUNT);
    if (destSlot == null) {
      // No empty slot - swap with currently selected hotbar slot
      // This will place the inventory item in the hotbar and move the
      // hotbar item to where the inventory item was
      destSlot = QUICK_BAR_START + bot.quickBarSlot;
    }

    // Move/swap the item to the hotbar slot
    await bot.moveSlotItem(sourceSlot, destSlot);
    // Select the destination slot as the new hand
    bot.setQuickBarSlot(destSlot - QUICK_BAR_START);
  }
  async function unequip(destination: EquipmentDestination | null): Promise<void> {
    if (!destination) {
      destination = 'hand';
    }

    if (destination === 'hand') {
      await equipEmpty();
    } else {
      await disrobe(destination);
    }
  }

  async function equipEmpty(): Promise<void> {
    // First, try to find an empty hotbar slot and select it
    for (let i = 0; i < QUICK_BAR_COUNT; ++i) {
      if (!bot.inventory.slots[QUICK_BAR_START + i]) {
        bot.setQuickBarSlot(i);
        return;
      }
    }

    // No empty hotbar slot, try to move held item to inventory
    const emptySlot = bot.inventory.firstEmptyInventorySlot(false); // false = don't check hotbar first (we already did)
    if (emptySlot === null) {
      // No room in inventory, toss the item
      if (bot.heldItem) {
        await bot.tossStack(bot.heldItem);
      }
      return;
    }

    // Move held item to empty inventory slot
    const equipSlot = QUICK_BAR_START + bot.quickBarSlot;
    if (bot.inventory.slots[equipSlot]) {
      await bot.moveSlotItem(equipSlot, emptySlot);
    }
  }

  async function disrobe(destination: EquipmentDestination): Promise<void> {
    const destSlot = getDestSlot(destination);
    const itemAtSlot = bot.inventory.slots[destSlot];

    if (!itemAtSlot) {
      return; // Nothing to unequip
    }

    // Find an empty inventory slot to move the armor to
    const emptySlot = bot.inventory.firstEmptyInventorySlot();
    if (emptySlot === null) {
      // No room in inventory, toss the item
      await bot.tossStack(itemAtSlot);
      return;
    }

    // Move armor piece to inventory
    await bot.moveSlotItem(destSlot, emptySlot);
  }
  async function toss(itemType: number, metadata: number | null, count: number | null): Promise<void> {
    // Find items matching the type/metadata in inventory
    const matchingItems = bot.inventory.slots.filter((item) => {
      if (!item) return false;
      if (item.type !== itemType) return false;
      if (metadata != null && item.metadata !== metadata) return false;
      return true;
    });

    if (matchingItems.length === 0) {
      throw new Error(`No item with type ${itemType} found in inventory`);
    }

    let remaining = count ?? 1;

    for (const item of matchingItems) {
      if (remaining <= 0) break;

      const tossCount = Math.min(remaining, item.count);

      // Send inventory_transaction for dropping items
      bot._client.write('inventory_transaction', {
        transaction: {
          legacy: {
            legacy_request_id: 0,
            legacy_transactions: [],
          },
          transaction_type: 'normal',
          actions: [
            {
              source_type: 'world_interaction',
              flags: 0,
              slot: 0,
              old_item: { network_id: 0 },
              new_item: Item.toNotch(
                Object.assign(Object.create(Object.getPrototypeOf(item)), item, {
                  count: tossCount,
                }),
                0
              ),
            },
            {
              source_type: 'container',
              inventory_id: 'inventory',
              slot: item.slot,
              old_item: Item.toNotch(item, 0),
              new_item:
                item.count - tossCount > 0
                  ? Item.toNotch(
                      Object.assign(Object.create(Object.getPrototypeOf(item)), item, {
                        count: item.count - tossCount,
                      }),
                      0
                    )
                  : { network_id: 0 },
            },
          ],
        },
      });

      // Update local inventory state
      if (item.count - tossCount > 0) {
        item.count -= tossCount;
        bot.inventory.updateSlot(item.slot, item);
      } else {
        bot.inventory.updateSlot(item.slot, null);
      }

      remaining -= tossCount;
    }
  }
  async function tossStack(item: Item): Promise<void> {
    assert.ok(item, 'Item is required for tossStack');

    // Open inventory if not already open
    if (!bot.currentWindow) {
      await bot.openInventory();
    }

    // Step 1: Take item to cursor
    await bot.clickWindow(item.slot, 0, 0);

    // Step 2: Drop from cursor (slot -999 triggers drop action)
    await bot.clickWindow(-999, 0, 0);

    // Close inventory
    if (bot.currentWindow) {
      bot.closeWindow(bot.currentWindow);
    }
  }
  function setQuickBarSlot(slot: number): void {
    assert.ok(slot >= 0 && slot < 9, `Invalid quickBarSlot: ${slot}`);
    if (bot.quickBarSlot === slot) return; // Already selected

    bot.quickBarSlot = slot;

    const selectedSlot = QUICK_BAR_START + slot;
    const hotbarItem = bot.inventory.slots[selectedSlot];

    bot._client.write('mob_equipment', {
      runtime_entity_id: bot.entity.id,
      item: hotbarItem ? Item.toNotch(hotbarItem, 0) : { network_id: 0 },
      slot: selectedSlot,
      selected_slot: selectedSlot,
      window_id: 'inventory',
    });

    bot.updateHeldItem();
  }
  function getDestSlot(destination: string): number {
    if (destination === 'hand') {
      return QUICK_BAR_START + bot.quickBarSlot;
    }
    const destSlot = armorSlots[destination];
    assert.ok(destSlot != null, `invalid destination: ${destination}`);
    return destSlot;
  }

  async function leftMouse(slot: number): Promise<void> {
    return bot.clickWindow(slot, 0, 0);
  }

  async function rightMouse(slot: number): Promise<void> {
    return bot.clickWindow(slot, 1, 0);
  }

  bot.equip = equip;
  bot.unequip = unequip;
  bot.toss = toss;
  bot.tossStack = tossStack;
  bot.setQuickBarSlot = setQuickBarSlot;
  bot.getEquipmentDestSlot = getDestSlot;
  bot.simpleClick = { leftMouse, rightMouse };
  bot.QUICK_BAR_START = QUICK_BAR_START; // 0 for Bedrock (36 for Java)
}
