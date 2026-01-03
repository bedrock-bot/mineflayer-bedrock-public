import type { Block } from 'prismarine-block';
import type { BedrockBot, TransferOptions } from '../../index.js';
import type { Vec3 } from 'vec3';
import type { Entity } from 'prismarine-entity';
import windowLoader, { type Window, type WindowsExports } from 'prismarine-windows';
import type { EventEmitter } from 'events';
import itemLoader, { type Item } from 'prismarine-item';
import type { protocolTypes } from '../../bedrock-types.js';
import assert from 'assert';
const QUICK_BAR_COUNT = 9;
// Bedrock slot layout: 0-8 hotbar, 9-35 inventory, 36-39 armor, 45 offhand
const QUICK_BAR_START = 0;

let nextRequestId = -861;
let nextLegacyRequestId = -1;

// Track pending inventory updates for sync
let lastInventoryContentTime = 0;

// Get next item_stack_request ID (shared across all plugins)
export function getNextItemStackRequestId(): number {
  nextRequestId -= 2;
  return nextRequestId + 2;
}

// Get next legacy_request_id for inventory_transaction packets
export function getNextLegacyRequestId(): number {
  return nextLegacyRequestId--;
}

export default function inject(bot: BedrockBot) {
  // Expose request ID getter on bot for other plugins (e.g., digging)
  bot.getNextItemStackRequestId = getNextItemStackRequestId;

  bot.activateBlock = activateBlock;
  bot.activateEntity = activateEntity;
  bot.activateEntityAt = activateEntityAt;
  bot.placeBlock = placeBlock;
  bot.consume = consume;
  bot.activateItem = activateItem;
  bot.deactivateItem = deactivateItem;

  // not really in the public API
  bot.clickWindow = clickWindow;
  bot.putSelectedItemRange = putSelectedItemRange;
  bot.putAway = putAway;
  bot.closeWindow = closeWindow;
  bot.transfer = transfer;
  bot.openBlock = openBlock;
  bot.openEntity = openEntity;
  bot.moveSlotItem = moveSlotItem;
  bot.updateHeldItem = updateHeldItem;
  bot.openInventory = openInventory;

  const Item = (itemLoader as any)(bot.registry) as typeof Item;
  const windows = (windowLoader as any)(bot.registry) as WindowsExports;

  bot.quickBarSlot = null;
  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  bot.inventory.hotbarStart = 0; // first 9 slots are crafting grid

  bot.currentWindow = null;
  bot.heldItem = null;
  bot.usingHeldItem = false;

  Object.defineProperty(bot, 'heldItem', {
    get: function () {
      return bot.inventory.slots[QUICK_BAR_START + bot.quickBarSlot];
    },
  });

  bot.on('heldItemChanged', (heldItem: Item | null) => {});

  bot._client.on('inventory_slot', (packet: protocolTypes.packet_inventory_slot) => {
    if (bot.item_registry_task) {
      //bot.item_registry_task.promise.then(handle);
    } else {
      handle();
    }
    function handle() {
      let window = getWindow(packet.window_id);
      if (!window) return;
      const newItem = Item.fromNotch(packet.item);
      // Preserve stack_id from Bedrock protocol
      if (newItem && packet.item.stack_id !== undefined) {
        (newItem as any).stackId = packet.item.stack_id;
      }
      const slotIndex = getSlotIndex(packet.window_id, packet.slot);
      //console.log("update window", packet.window_id, packet.slot, newItem);
      window.updateSlot(slotIndex, newItem);
      updateHeldItem();
    }
  });

  bot._client.on('inventory_transaction', (packet: protocolTypes.packet_inventory_transaction) => {
    const transaction = packet.transaction;
    if (bot.item_registry_task) {
      //bot.item_registry_task.promise.then(handle);
    } else {
      handle();
    }
    function handle() {
      for (const action of transaction.actions) {
        if (action.source_type === 'container') {
          let window = getWindow(action.inventory_id);
          const newItem = Item.fromNotch(action.new_item);
          // Preserve stack_id from Bedrock protocol
          if (newItem && action.new_item.stack_id !== undefined) {
            (newItem as any).stackId = action.new_item.stack_id;
          }
          const slotIndex = getSlotIndex(action.inventory_id, action.slot);
          window.updateSlot(slotIndex, newItem);
          updateHeldItem();

          // console.log(
          //   "update window",
          //   action.inventory_id,
          //   slotIndex,
          //   newItem
          // );
        } else if (action.source_type === 'world_interaction' || action.source_type === 'creative') {
        } else {
          assert(false);
        }
      }
    }
  });
  bot._client.on('inventory_content', (packet: protocolTypes.packet_inventory_content) => {
    const window = bot.currentWindow?.id == packet.window_id ? bot.currentWindow : getWindow(packet.window_id);
    if (!window) return;

    if (packet.window_id === 'inventory') {
      for (let i = 0; i < packet.input.length; i++) {
        const inputItem = packet.input[i];
        const newItem = Item.fromNotch(inputItem);
        // Preserve stack_id from Bedrock protocol
        if (newItem && inputItem.stack_id !== undefined) {
          (newItem as any).stackId = inputItem.stack_id;
        }
        //const slotIndex = getSlotIndex(packet.window_id === 'inventory' && i <=8 ? 'hotbar':'inventory', i);
        window.updateSlot(i, newItem);
        //console.log("update window", packet.window_id, i, newItem);
      }
    } else {
      // For container windows like chests
      for (let i = 0; i < packet.input.length; i++) {
        const inputItem = packet.input[i];
        const newItem = Item.fromNotch(inputItem);
        // Preserve stack_id from Bedrock protocol
        if (newItem && inputItem.stack_id !== undefined) {
          (newItem as any).stackId = inputItem.stack_id;
        }
        const slotIndex = getSlotIndex(packet.window_id, i);
        window.updateSlot(slotIndex, newItem);
      }
    }

    // Update held item reference
    updateHeldItem();

    // Track inventory content time for sync
    if (packet.window_id === 'inventory') {
      lastInventoryContentTime = Date.now();
      bot.emit('inventorySync');
    }

    // Emit event to signal window items have been set
    bot.emit(`setWindowItems:${window.id}`);
  });

  // Wait for next inventory_content packet (with timeout)
  function waitForInventorySync(timeout: number = 200): Promise<void> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      // If we recently received inventory_content, resolve immediately
      if (Date.now() - lastInventoryContentTime < 50) {
        resolve();
        return;
      }

      const handler = () => {
        cleanup();
        resolve();
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(); // Timeout - proceed anyway
      }, timeout);

      const cleanup = () => {
        bot.removeListener('inventorySync', handler);
        clearTimeout(timer);
      };

      bot.once('inventorySync', handler);
    });
  }

  bot._client.on('player_hotbar', (packet: protocolTypes.packet_player_hotbar) => {
    // Update the selected hotbar slot
    // This is sent by the server when the player changes their selected hotbar slot
    if (packet.select_slot) {
      const slot = packet.selected_slot;

      // Validate slot is within hotbar range (0-8)
      if (slot >= 0 && slot < 9) {
        bot.quickBarSlot = slot;
        updateHeldItem();
      }
    }
  });

  bot._client.on('play_status', (packet: protocolTypes.packet_play_status) => {
    if (packet.status === 'player_spawn') {
      // After receiving player_spawn, we need to send 2 mob_equipment packets
      // 1. For the active hotbar item
      // 2. For the offhand item

      // Default to slot 0 if quickBarSlot is not set yet
      const selectedSlot = getSlotIndex('inventory', bot.quickBarSlot ?? 0);

      // Send mob_equipment for active hotbar item
      const hotbarItem = bot.inventory.slots[selectedSlot];
      bot._client.write('mob_equipment', {
        runtime_entity_id: bot.entity.id,
        item: hotbarItem ? Item.toNotch(hotbarItem, 0) : { network_id: 0 },
        slot: selectedSlot,
        selected_slot: selectedSlot,
        window_id: 'inventory',
      });

      // Send mob_equipment for offhand item
      const offhandItem = bot.inventory.slots[45]; // offhand slot
      bot._client.write('mob_equipment', {
        runtime_entity_id: bot.entity.id,
        item: offhandItem ? Item.toNotch(offhandItem, 0) : { network_id: 0 },
        slot: 1,
        selected_slot: 0,
        window_id: 'offhand',
      });
    }
  });

  bot._client.on('container_open', (packet: protocolTypes.packet_container_open) => {
    // Special case: when opening player's own inventory, use bot.inventory as currentWindow
    if (packet.window_type === 'inventory') {
      bot.currentWindow = bot.inventory;
      bot.currentWindow.id = packet.window_id;
      // Inventory is already populated, emit windowOpen immediately
      bot.emit('windowOpen', bot.currentWindow);
      return;
    }

    // Map Bedrock window types to prismarine-windows compatible types
    const windowTypeMap: Record<string, string> = {
      container: 'minecraft:generic_9x3', // Default chest
      workbench: 'minecraft:crafting_table',
      furnace: 'minecraft:furnace',
      enchantment: 'minecraft:enchantment',
      brewing_stand: 'minecraft:brewing_stand',
      anvil: 'minecraft:anvil',
      dispenser: 'minecraft:dispenser',
      dropper: 'minecraft:dropper',
      hopper: 'minecraft:hopper',
      beacon: 'minecraft:beacon',
      loom: 'minecraft:loom',
      grindstone: 'minecraft:grindstone',
      blast_furnace: 'minecraft:blast_furnace',
      smoker: 'minecraft:smoker',
      stonecutter: 'minecraft:stonecutter',
      horse: 'EntityHorse',
    };

    const windowType = windowTypeMap[packet.window_type] || 'minecraft:generic_9x3';

    // Create a new window for this container
    const newWindow = windows.createWindow(
      packet.window_id,
      windowType,
      packet.window_type, // Use window_type as title for now
      undefined // slotCount will be determined by window type
    );
    bot.currentWindow = newWindow;

    // Wait for inventory_content packet to populate the window before emitting windowOpen
    bot.once(`setWindowItems:${newWindow.id}`, () => {
      // Add container helper methods to the window
      addContainerMethods(newWindow);
      bot.emit('windowOpen', newWindow);
    });
  });

  /**
   * Add withdraw/deposit/close helper methods to a container window
   */
  function addContainerMethods(window: Window): void {
    // Don't add to player inventory
    if (window === bot.inventory) return;

    /**
     * Withdraw items from container to player inventory
     * In Bedrock, player inventory is separate from container window
     */
    (window as any).withdraw = async (itemType: number, metadata: number | null, count: number | null, nbt?: object | null): Promise<void> => {
      const containerSlots = window.inventoryStart !== undefined ? window.inventoryStart : 27;
      // Source is container window slots 0 to containerSlots-1
      // Destination is player inventory (bot.inventory)
      return withdrawFromContainer(window, itemType, metadata, count, nbt, containerSlots);
    };

    /**
     * Deposit items from player inventory to container
     * In Bedrock, player inventory is separate from container window
     */
    (window as any).deposit = async (itemType: number, metadata: number | null, count: number | null, nbt?: object | null): Promise<void> => {
      const containerSlots = window.inventoryStart !== undefined ? window.inventoryStart : 27;
      // Source is player inventory (bot.inventory)
      // Destination is container window slots 0 to containerSlots-1
      return depositToContainer(window, itemType, metadata, count, nbt, containerSlots);
    };

    /**
     * Close this container window
     */
    (window as any).close = (): void => {
      bot.closeWindow(window);
    };
  }

  bot._client.on('item_stack_response', (packet: protocolTypes.packet_item_stack_response) => {
    // Process each response in the packet
    for (const response of packet.responses) {
      const { status, request_id, containers } = response;

      if (status === 'ok') {
        for (const container of containers) {
          const containerId = container.slot_type?.container_id;

          // Skip cursor updates - cursor is temporary and not a real inventory slot
          if (containerId === 'cursor') continue;

          // Determine which window to update based on containerId
          let window: Window | null;
          if (containerId === 'container') {
            // Container slots belong to the open container window
            window = bot.currentWindow;
          } else if (containerId === 'inventory' || containerId === 'hotbar' || containerId === 'armor' || containerId === 'offhand') {
            // Player inventory slots
            window = bot.inventory;
          } else {
            // Unknown container, skip
            continue;
          }

          if (!window) continue;

          if (container.slots) {
            for (const slotData of container.slots) {
              // Map slot index based on containerId
              const slotIndex = getSlotIndex(containerId as protocolTypes.WindowID, slotData.slot);

              if (slotData.item_stack_id === 0 || slotData.count === 0) {
                window.updateSlot(slotIndex, null);
              } else {
                // Update the stack_id and count of existing item if present
                const existingItem = window.slots[slotIndex];
                if (existingItem) {
                  existingItem.count = slotData.count;
                  (existingItem as any).stackId = slotData.item_stack_id;
                }
              }
            }
          }
        }

        // Emit success event for this request
        bot.emit(`itemStackResponse:${request_id}`, true);
      } else {
        // Transaction was rejected by the server
        bot.emit(`itemStackResponse:${request_id}`, false);
      }

      updateHeldItem();
    }
  });

  bot._client.on('container_close', (packet: protocolTypes.packet_container_close) => {
    // Close the container window
    const oldWindow = bot.currentWindow;

    if (oldWindow && oldWindow.id === packet.window_id) {
      bot.currentWindow = null;
      bot.emit('windowClose', oldWindow);
    }
  });

  ////////////////////////////////////////////////////////////////

  async function activateBlock(block: Block, direction?: Vec3, cursorPos?: Vec3): Promise<void> {
    // Wait for any pending inventory updates from previous operations
    // This prevents race conditions where item pickups haven't been processed yet
    await waitForInventorySync(200);

    // Calculate face direction based on bot position relative to block
    let face: number;
    if (direction) {
      face = getFaceFromDirection(direction);
    } else {
      // Auto-calculate face based on bot position
      const dx = bot.entity.position.x - block.position.x - 0.5;
      const dy = bot.entity.position.y - block.position.y - 0.5;
      const dz = bot.entity.position.z - block.position.z - 0.5;
      const ax = Math.abs(dx),
        ay = Math.abs(dy),
        az = Math.abs(dz);

      if (ax >= ay && ax >= az) {
        face = dx > 0 ? 5 : 4; // east or west
      } else if (ay >= ax && ay >= az) {
        face = dy > 0 ? 1 : 0; // top or bottom
      } else {
        face = dz > 0 ? 3 : 2; // south or north
      }
    }

    // Default click position (center of face)
    const clickPos = cursorPos || { x: 0.5, y: 0.5, z: 0.5 };
    await bot.lookAt(block.position.offset(clickPos.x, clickPos.y, clickPos.z), true);

    // Get block runtime ID
    const blockRuntimeId = (block as any).stateId || 0;

    const entityId = bot.entity.id;
    const hotbarSlot = bot.quickBarSlot ?? 0;
    const heldItem = bot.heldItem;

    // Helper to format item for packets (matching real client format)
    function formatItemForPacket(item: typeof heldItem) {
      if (!item) return { network_id: 0 };
      const notch = Item.toNotch(item, 0);
      // Ensure extra fields have correct format
      if (notch.extra) {
        notch.extra.can_place_on = notch.extra.can_place_on || [];
        notch.extra.can_destroy = notch.extra.can_destroy || [];
      } else {
        notch.extra = { has_nbt: 0, can_place_on: [], can_destroy: [] };
      }
      // Real client sends has_stack_id: 0 for inventory_transaction items
      notch.has_stack_id = 0;
      delete notch.stack_id;
      return notch;
    }

    // 0. Send mob_equipment FIRST to sync held item state with server
    const heldItemForEquip = formatItemForPacket(heldItem);
    bot._client.write('mob_equipment', {
      runtime_entity_id: entityId,
      item: heldItemForEquip,
      slot: hotbarSlot,
      selected_slot: hotbarSlot,
      window_id: 'inventory',
    });

    // 1. Send player_action: start_item_use_on
    bot._client.write('player_action', {
      runtime_entity_id: entityId,
      action: 'start_item_use_on',
      position: {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
      },
      result_position: {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
      },
      face: face,
    });

    // 2. Send animate: swing_arm with 'build' source
    bot._client.write('animate', {
      action_id: 'swing_arm',
      runtime_entity_id: entityId,
      data: 0,
      has_swing_source: true,
      swing_source: 'build',
    });

    // 3. Send inventory_transaction with item_use
    const heldItemNotch = formatItemForPacket(heldItem);
    const newCount = heldItem ? heldItem.count - 1 : 0;
    const newItemNotch = newCount > 0 ? formatItemForPacket({ ...heldItem!, count: newCount } as typeof heldItem) : { network_id: 0 };

    // Build actions array if we have a held item that will be consumed
    // Use heldItem.slot for accuracy (hotbarSlot might differ)
    const itemSlot = heldItem?.slot ?? hotbarSlot;
    const actions = heldItem
      ? [
          {
            source_type: 'container',
            inventory_id: 'inventory',
            slot: itemSlot,
            old_item: heldItemNotch,
            new_item: newItemNotch,
          },
        ]
      : [];

    bot._client.write('inventory_transaction', {
      transaction: {
        legacy: {
          legacy_request_id: 0,
        },
        transaction_type: 'item_use',
        actions: actions,
        transaction_data: {
          action_type: 'click_block',
          trigger_type: 'player_input',
          block_position: {
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
          },
          face: face,
          hotbar_slot: hotbarSlot,
          held_item: heldItemNotch,
          player_pos: {
            x: bot.entity.position.x,
            y: bot.entity.position.y + 1.62,
            z: bot.entity.position.z,
          },
          click_pos: {
            x: clickPos.x,
            y: clickPos.y,
            z: clickPos.z,
          },
          block_runtime_id: blockRuntimeId,
          client_prediction: 'success',
        },
      },
    });

    // 4. Send mob_equipment to update server with new held item count
    const updatedItemNotch = newCount > 0 ? formatItemForPacket({ ...heldItem!, count: newCount } as typeof heldItem) : { network_id: 0 };

    bot._client.write('mob_equipment', {
      runtime_entity_id: entityId,
      item: updatedItemNotch,
      slot: itemSlot,
      selected_slot: hotbarSlot,
      window_id: 'inventory',
    });

    // 5. Send stop_item_use_on to signal end of placement
    bot._client.write('player_action', {
      runtime_entity_id: entityId,
      action: 'stop_item_use_on',
      position: {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
      },
      result_position: { x: 0, y: 0, z: 0 },
      face: 0,
    });

    // 6. Wait for server to confirm the placement via inventory_content
    // This ensures the server has processed our transaction before we return
    await waitForInventorySync(200);
  }

  async function placeBlock(referenceBlock: Block, faceVector: Vec3): Promise<void> {
    // placeBlock is essentially activateBlock with a direction
    // Used for placing blocks/seeds on a reference block face
    await activateBlock(referenceBlock, faceVector);
  }

  async function activateEntity(entity: Entity): Promise<void> {
    await bot.lookAt(entity.position.offset(0, 1, 0), false);
    bot._client.write('interact', {
      action_id: 'interact',
      target_entity_id: entity.id,
      position: { x: 0, y: 0, z: 0 },
      has_position: false,
    });
  }

  async function activateEntityAt(entity: Entity, position: Vec3): Promise<void> {
    await bot.lookAt(position, false);
    bot._client.write('interact', {
      action_id: 'interact',
      target_entity_id: entity.id,
      position: {
        x: position.x - entity.position.x,
        y: position.y - entity.position.y,
        z: position.z - entity.position.z,
      },
      has_position: true,
    });
  }

  // Consumable items that can always be used
  const ALWAYS_CONSUMABLES = ['potion', 'milk_bucket', 'honey_bottle', 'suspicious_stew'];
  const CONSUME_TIMEOUT = 5000;

  async function consume(): Promise<void> {
    if (!bot.heldItem) {
      throw new Error('No item in hand');
    }

    // Check if food is full (unless always consumable or creative)
    if (bot.game?.gameMode !== 'creative' && !ALWAYS_CONSUMABLES.includes(bot.heldItem.name) && bot.food === 20) {
      throw new Error('Food is full');
    }

    bot.usingHeldItem = true;

    // Start using the item
    activateItem(false);

    // Wait for eating to complete via inventory update
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bot.usingHeldItem = false;
        reject(new Error('Consume timeout'));
      }, CONSUME_TIMEOUT);

      const onSlotUpdate = () => {
        clearTimeout(timeout);
        bot.usingHeldItem = false;
        bot.inventory.removeListener('updateSlot', onSlotUpdate);
        resolve();
      };

      bot.inventory.once('updateSlot', onSlotUpdate);
    });
  }

  function activateItem(offhand: boolean = false): void {
    bot.usingHeldItem = true;

    const position = bot.entity.position;
    const blockPos = position.floored();

    // For Bedrock, we use inventory_transaction with item_use action type 'use'
    bot._client.write('inventory_transaction', {
      transaction: {
        legacy: {
          legacy_request_id: 0,
        },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: {
          action_type: 'use',
          trigger_type: 'player_input',
          block_position: {
            x: blockPos.x,
            y: blockPos.y,
            z: blockPos.z,
          },
          face: -1,
          hotbar_slot: bot.quickBarSlot ?? 0,
          held_item: bot.heldItem ? Item.toNotch(bot.heldItem, 0) : { network_id: 0 },
          player_pos: {
            x: position.x,
            y: position.y + 1.62,
            z: position.z,
          },
          click_pos: { x: 0, y: 0, z: 0 },
          block_runtime_id: 0,
          client_prediction: 'success',
        },
      },
    });
  }

  function deactivateItem(): void {
    bot.usingHeldItem = false;

    // Send player_action with abort_item_use
    bot._client.write('player_action', {
      runtime_entity_id: bot.entity.id,
      action: 'abort_item_use',
      position: {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z,
      },
      result_position: {
        x: 0,
        y: 0,
        z: 0,
      },
      face: 0,
    });
  }

  function createActionNumber() {
    nextRequestId = nextRequestId - 2;
    return nextRequestId + 2;
  }

  // Track cursor item for clickWindow operations
  let cursorItem: Item | null = null;

  // Expose cursor item as selectedItem on windows
  Object.defineProperty(bot.inventory, 'selectedItem', {
    get: () => cursorItem,
    set: (value) => {
      cursorItem = value;
    },
  });

  async function clickWindow(slot: number, mouseButton: number, mode: number): Promise<void> {
    const window = bot.currentWindow || bot.inventory;
    assert.ok(mode >= 0 && mode <= 4, `Mode ${mode} is not supported (valid: 0-4)`);

    // Handle different click modes
    if (mode === 1) {
      // Mode 1: Shift-click (quick transfer)
      return clickWindowMode1(slot, window);
    } else if (mode === 2) {
      // Mode 2: Number key swap (mouseButton = hotbar slot 0-8)
      return clickWindowMode2(slot, mouseButton, window);
    } else if (mode === 3) {
      // Mode 3: Creative clone (middle-click to clone item to cursor)
      return clickWindowMode3(slot, window);
    } else if (mode === 4) {
      // Mode 4: Q key drop (mouseButton 0 = drop 1, mouseButton 1 = drop stack)
      return clickWindowMode4(slot, mouseButton, window);
    }

    // Mode 0: Normal click (left/right)
    const requestId = createActionNumber();

    // Drop from cursor (slot -999)
    if (slot === -999) {
      if (!cursorItem) {
        return; // Nothing to drop
      }

      // Right-click drops 1 item, left-click drops entire stack
      const dropCount = mouseButton === 1 ? 1 : cursorItem.count;

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: requestId,
            actions: [
              {
                type_id: 'drop',
                count: dropCount,
                source: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: (cursorItem as any).stackId || 0,
                },
                randomly: false,
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      const success = await waitForResponse(requestId);
      if (success) {
        if (dropCount >= cursorItem.count) {
          cursorItem = null;
        } else {
          cursorItem.count -= dropCount;
        }
      }
      return;
    }

    const sourceItem = window.slots[slot];
    const sourceContainer = getContainerFromSlot(slot, window);

    // Case 1: Cursor is empty - pick up item from slot
    if (!cursorItem) {
      if (!sourceItem) {
        return; // Nothing to pick up
      }

      // Right-click picks up half, left-click picks up all
      const takeCount = mouseButton === 1 ? Math.ceil(sourceItem.count / 2) : sourceItem.count;

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: requestId,
            actions: [
              {
                type_id: 'take',
                count: takeCount,
                source: {
                  slot_type: { container_id: sourceContainer.containerId },
                  slot: sourceContainer.slot,
                  stack_id: (sourceItem as any).stackId || 0,
                },
                destination: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: 0,
                },
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      const success = await waitForResponse(requestId);
      if (success) {
        // Create a copy of the item for cursor with the taken count
        cursorItem = Object.assign(Object.create(Object.getPrototypeOf(sourceItem)), sourceItem);
        cursorItem.count = takeCount;
        (cursorItem as any).stackId = (sourceItem as any).stackId;

        if (takeCount >= sourceItem.count) {
          window.updateSlot(slot, null);
        } else {
          sourceItem.count -= takeCount;
          window.updateSlot(slot, sourceItem);
        }
      }
      return;
    }

    // Case 2: Cursor has item - place item into slot
    if (!sourceItem) {
      // Empty slot - place cursor item
      const placeCount = mouseButton === 1 ? 1 : cursorItem.count;

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: requestId,
            actions: [
              {
                type_id: 'place',
                count: placeCount,
                source: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: (cursorItem as any).stackId || 0,
                },
                destination: {
                  slot_type: { container_id: sourceContainer.containerId },
                  slot: sourceContainer.slot,
                  stack_id: 0,
                },
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      const success = await waitForResponse(requestId);
      if (success) {
        // Create new item for slot
        const newItem = Object.assign(Object.create(Object.getPrototypeOf(cursorItem)), cursorItem);
        newItem.count = placeCount;
        newItem.slot = slot;
        window.updateSlot(slot, newItem);

        if (placeCount >= cursorItem.count) {
          cursorItem = null;
        } else {
          cursorItem.count -= placeCount;
        }
      }
      return;
    }

    // Case 3: Both slot and cursor have items
    // If same item type, try to combine (right-click places 1, left-click places all)
    if (sourceItem.type === cursorItem.type && sourceItem.metadata === cursorItem.metadata) {
      const canStack = sourceItem.count < sourceItem.stackSize;
      if (canStack) {
        const spaceAvailable = sourceItem.stackSize - sourceItem.count;
        const placeCount = mouseButton === 1 ? 1 : Math.min(cursorItem.count, spaceAvailable);

        if (placeCount > 0) {
          bot._client.write('item_stack_request', {
            requests: [
              {
                request_id: requestId,
                actions: [
                  {
                    type_id: 'place',
                    count: placeCount,
                    source: {
                      slot_type: { container_id: 'cursor' },
                      slot: 0,
                      stack_id: (cursorItem as any).stackId || 0,
                    },
                    destination: {
                      slot_type: { container_id: sourceContainer.containerId },
                      slot: sourceContainer.slot,
                      stack_id: (sourceItem as any).stackId || 0,
                    },
                  },
                ],
                custom_names: [],
                cause: -1,
              },
            ],
          });

          const success = await waitForResponse(requestId);
          if (success) {
            sourceItem.count += placeCount;
            window.updateSlot(slot, sourceItem);

            if (placeCount >= cursorItem.count) {
              cursorItem = null;
            } else {
              cursorItem.count -= placeCount;
            }
          }
          return;
        }
      }
    }

    // Different item types or can't stack - swap
    bot._client.write('item_stack_request', {
      requests: [
        {
          request_id: requestId,
          actions: [
            {
              type_id: 'swap',
              source: {
                slot_type: { container_id: sourceContainer.containerId },
                slot: sourceContainer.slot,
                stack_id: (sourceItem as any).stackId || 0,
              },
              destination: {
                slot_type: { container_id: 'cursor' },
                slot: 0,
                stack_id: (cursorItem as any).stackId || 0,
              },
            },
          ],
          custom_names: [],
          cause: -1,
        },
      ],
    });

    const success = await waitForResponse(requestId);
    if (success) {
      const oldCursor = cursorItem;
      cursorItem = sourceItem;
      window.updateSlot(slot, oldCursor);
    }
  }

  async function putSelectedItemRange(start: number, end: number, window: Window, slot: any): Promise<void> {
    // Put the cursor item into the slot range in window
    // Try to stack with existing items first, then use empty slots
    while (cursorItem) {
      // Try to find an existing stack to combine with
      const existingItem = window.findItemRange(
        start,
        end,
        cursorItem.type,
        cursorItem.metadata,
        true, // notFull - only find stacks that aren't full
        cursorItem.nbt
      );

      if (existingItem && existingItem.stackSize !== existingItem.count) {
        // Found an existing stack to combine with
        await clickWindow(existingItem.slot, 0, 0);
      } else {
        // No existing stack, find empty slot
        const emptySlot = window.firstEmptySlotRange(start, end);
        if (emptySlot === null) {
          // No room left
          if (slot === null) {
            // Drop the item
            await clickWindow(-999, 0, 0);
          } else {
            // Place at fallback slot, then drop any remainder
            await clickWindow(slot, 0, 0);
            if (cursorItem) {
              await clickWindow(-999, 0, 0);
            }
          }
        } else {
          await clickWindow(emptySlot, 0, 0);
        }
      }
    }
  }

  async function putAway(slot: number): Promise<void> {
    const window = bot.currentWindow || bot.inventory;
    const item = window.slots[slot];

    if (!item) {
      return; // Nothing to put away
    }

    // Click on slot to pick up item to cursor
    await clickWindow(slot, 0, 0);

    // Put cursor item into inventory
    const start = window.inventoryStart ?? 9;
    const end = window.inventoryEnd ?? 44;
    await putSelectedItemRange(start, end, window, null);
  }

  async function closeWindow(window: Window): Promise<void> {
    if (!window || window === bot.inventory) return; // Can't close player inventory

    bot._client.write('container_close', {
      window_id: window.id,
      window_type: 'none',
      server: false,
    });

    // Wait for server confirmation
    await onceWithCleanup(bot._client, 'container_close', 5000);
  }

  async function transfer(options: TransferOptions): Promise<void> {
    const window = options.window || bot.currentWindow || bot.inventory;
    const itemType = options.itemType;
    const metadata = options.metadata;
    const nbt = options.nbt;
    let count = options.count === undefined || options.count === null ? 1 : options.count;
    let firstSourceSlot: number | null = null;

    // ranges
    const sourceStart = options.sourceStart;
    const destStart = options.destStart;
    assert.notStrictEqual(sourceStart, null, 'sourceStart is required');
    assert.notStrictEqual(destStart, null, 'destStart is required');
    const sourceEnd = options.sourceEnd === null ? sourceStart + 1 : options.sourceEnd;
    const destEnd = options.destEnd === null ? destStart + 1 : options.destEnd;

    await transferOne();

    async function transferOne(): Promise<void> {
      if (count === 0) {
        await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot);
        return;
      }

      // Check if we need to pick up a new item
      if (!cursorItem || cursorItem.type !== itemType || (metadata != null && cursorItem.metadata !== metadata) || (nbt != null && cursorItem.nbt !== nbt)) {
        // Find item in source range
        const sourceItem = window.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt);
        const mcDataEntry = bot.registry.itemsArray.find((x: any) => x.id === itemType);
        assert(mcDataEntry, 'Invalid itemType');

        if (!sourceItem) {
          throw new Error(`Can't find ${mcDataEntry.name} in slots [${sourceStart} - ${sourceEnd}], (item id: ${itemType})`);
        }

        if (firstSourceSlot === null) {
          firstSourceSlot = sourceItem.slot;
        }

        // Pick up item to cursor
        await clickWindow(sourceItem.slot, 0, 0);
      }

      await clickDest();
    }

    async function clickDest(): Promise<void> {
      assert.notStrictEqual(cursorItem?.type, null);

      let destItem: Item | null = null;
      let destSlot: number | null;

      // Special case for tossing
      if (destStart === -999) {
        destSlot = -999;
      } else {
        // Find a non-full item to stack with
        destItem = window.findItemRange(destStart, destEnd, cursorItem!.type, cursorItem!.metadata, true, nbt);

        // If no stackable item, find empty slot
        destSlot = destItem ? destItem.slot : window.firstEmptySlotRange(destStart, destEnd);

        if (destSlot === null) {
          throw new Error('destination full');
        }
      }

      // Calculate how many items we can move
      const destSlotCount = destItem?.count ?? 0;
      const movedItems = Math.min(cursorItem!.stackSize - destSlotCount, cursorItem!.count);

      // If moving more items than count needs, use right-click to place one at a time
      if (movedItems <= count) {
        await clickWindow(destSlot, 0, 0);
        count -= movedItems;
        await transferOne();
      } else {
        // Right-click to place one at a time
        for (let i = 0; i < count && cursorItem; i++) {
          await clickWindow(destSlot, 1, 0);
        }
        count = 0;
        await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot);
      }
    }
  }

  async function openBlock(block: Block, direction?: Vec3, cursorPos?: Vec3): Promise<Window> {
    // Calculate face direction based on bot position relative to block
    let face: number;
    if (direction) {
      face = getFaceFromDirection(direction);
    } else {
      // Auto-calculate face based on bot position
      const dx = bot.entity.position.x - block.position.x - 0.5;
      const dy = bot.entity.position.y - block.position.y - 0.5;
      const dz = bot.entity.position.z - block.position.z - 0.5;
      const ax = Math.abs(dx),
        ay = Math.abs(dy),
        az = Math.abs(dz);

      if (ax >= ay && ax >= az) {
        face = dx > 0 ? 5 : 4; // east or west
      } else if (ay >= ax && ay >= az) {
        face = dy > 0 ? 1 : 0; // top or bottom
      } else {
        face = dz > 0 ? 3 : 2; // south or north
      }
    }

    // Default click position (center of face)
    const clickPos = cursorPos || { x: 0.5, y: 0.5, z: 0.5 };
    await bot.lookAt(block.position.offset(clickPos.x, clickPos.y, clickPos.z), true);

    // Get block runtime ID from the block (convert to unsigned 32-bit)
    const signedId = (block as any).stateId || 0;
    const blockRuntimeId = signedId; // Convert to unsigned 32-bit

    // Calculate result position (adjacent block based on face)
    const faceOffsets = [
      { x: 0, y: -1, z: 0 }, // 0 = bottom
      { x: 0, y: 1, z: 0 }, // 1 = top
      { x: 0, y: 0, z: -1 }, // 2 = north
      { x: 0, y: 0, z: 1 }, // 3 = south
      { x: -1, y: 0, z: 0 }, // 4 = west
      { x: 1, y: 0, z: 0 }, // 5 = east
    ];
    const offset = faceOffsets[face] || { x: 0, y: 1, z: 0 };
    const resultPosition = {
      x: block.position.x + offset.x,
      y: block.position.y + offset.y,
      z: block.position.z + offset.z,
    };

    // Get entity ID as string (handle BigInt)
    const entityId = bot.entity.id;

    // 1. Send player_action: start_item_use_on (like real client)
    bot._client.write('player_action', {
      runtime_entity_id: entityId,
      action: 'start_item_use_on',
      position: {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
      },
      result_position: resultPosition,
      face: face,
    });

    // 2. Send animate: swing_arm (like real client)
    bot._client.queue('animate', {
      action_id: 'swing_arm',
      runtime_entity_id: entityId,
      data: 0,
      has_swing_source: true,
      swing_source: 'interact',
    });

    // 3. Send inventory_transaction to interact with the block
    bot._client.write('inventory_transaction', {
      transaction: {
        legacy: {
          legacy_request_id: 0,
        },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: {
          action_type: 'click_block',
          trigger_type: 'player_input',
          block_position: {
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
          },
          face: face,
          hotbar_slot: bot.quickBarSlot ?? 0,
          held_item: bot.heldItem ? Item.toNotch(bot.heldItem, 0) : { network_id: 0 },
          player_pos: {
            x: bot.entity.position.x,
            y: bot.entity.position.y + 1.62, // Eye height
            z: bot.entity.position.z,
          },
          click_pos: {
            x: clickPos.x,
            y: clickPos.y,
            z: clickPos.z,
          },
          block_runtime_id: blockRuntimeId,
          client_prediction: 'success',
        },
      },
    });

    // Wait for container_open response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bot.removeListener('windowOpen', onWindowOpen);
        reject(new Error('Timeout waiting for container to open'));
      }, 10000);

      const onWindowOpen = (window: Window) => {
        clearTimeout(timeout);
        resolve(window);
      };

      bot.once('windowOpen', onWindowOpen);
    });
  }

  function getFaceFromDirection(direction: Vec3): number {
    // Convert direction vector to face ID
    // 0 = bottom (-Y), 1 = top (+Y), 2 = north (-Z), 3 = south (+Z), 4 = west (-X), 5 = east (+X)
    if (direction.y < 0) return 0;
    if (direction.y > 0) return 1;
    if (direction.z < 0) return 2;
    if (direction.z > 0) return 3;
    if (direction.x < 0) return 4;
    if (direction.x > 0) return 5;
    return 1; // Default to top
  }

  async function openEntity(entity: Entity, Class: new () => EventEmitter): Promise<Window> {
    // Send interact packet to open entity's inventory
    bot._client.write('interact', {
      action_id: 'open_inventory',
      target_entity_id: entity.id,
      has_position: false,
    });

    // Wait for container_open response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bot.removeListener('windowOpen', onWindowOpen);
        reject(new Error('Timeout waiting for entity container to open'));
      }, 10000);

      const onWindowOpen = (window: Window) => {
        clearTimeout(timeout);
        resolve(window);
      };

      bot.once('windowOpen', onWindowOpen);
    });
  }

  async function openInventory() {
    // Step 1: Open the inventory by interacting with the player entity
    bot._client.write('interact', {
      action_id: 'open_inventory',
      target_entity_id: bot.entity.id,
      has_position: false,
    });

    return await onceWithCleanup(bot._client, 'container_open');
  }

  async function moveSlotItem(sourceSlot: number, destSlot: number): Promise<void> {
    const sourceItem = bot.inventory.slots[sourceSlot];
    if (!sourceItem) {
      throw new Error(`No item at source slot ${sourceSlot}`);
    }

    const destItem = bot.inventory.slots[destSlot];

    // For normal take/place operations through cursor, use "inventory" container
    // for all player inventory slots (0-35). Based on real client packet captures,
    // the "inventory" container encompasses both hotbar (0-8) and main inventory (9-35)
    // when doing normal click operations. Only shift-click uses separate containers.
    const sourceContainer = getContainerForCursorOp(sourceSlot);
    const destContainer = getContainerForCursorOp(destSlot);

    // Capture item counts before any response processing that might modify them
    const sourceCount = sourceItem.count;
    const destCount = destItem?.count ?? 0;

    // Only open inventory if not already open
    if (!bot.currentWindow || bot.currentWindow.id !== 'inventory') {
      await openInventory();
    }

    const requestId = nextRequestId;
    nextRequestId -= 2;

    // Offhand requires two separate requests (take to cursor, then place to offhand)
    // Other destinations can use a single request
    const isOffhand = destContainer.containerId === 'offhand';

    if (isOffhand && !destItem) {
      // Offhand: Send two separate requests
      // Request 1: Take to cursor
      const takeRequestId = nextRequestId;
      nextRequestId -= 2;

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: takeRequestId,
            actions: [
              {
                type_id: 'take',
                count: sourceItem.count,
                source: {
                  slot_type: { container_id: sourceContainer.containerId },
                  slot: sourceContainer.slot,
                  stack_id: (sourceItem as any).stackId || 0,
                },
                destination: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: 0,
                },
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      const takeSuccess = await waitForResponse(takeRequestId);
      if (!takeSuccess) {
        throw new Error('Failed to take item to cursor for offhand');
      }

      // Request 2: Place to offhand
      const placeRequestId = nextRequestId;
      nextRequestId -= 2;

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: placeRequestId,
            actions: [
              {
                type_id: 'place',
                count: sourceItem.count,
                source: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: (sourceItem as any).stackId || 0,
                },
                destination: {
                  slot_type: { container_id: destContainer.containerId },
                  slot: destContainer.slot,
                  stack_id: 0,
                },
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      const placeSuccess = await waitForResponse(placeRequestId);
      if (!placeSuccess) {
        throw new Error('Failed to place item to offhand');
      }
    } else {
      // Non-offhand: Single request
      const actions = [];

      if (destItem) {
        // Swap action for occupied destination
        actions.push({
          type_id: 'swap',
          source: {
            slot_type: { container_id: sourceContainer.containerId },
            slot: sourceContainer.slot,
            stack_id: (sourceItem as any).stackId || 0,
          },
          destination: {
            slot_type: { container_id: destContainer.containerId },
            slot: destContainer.slot,
            stack_id: (destItem as any).stackId || 0,
          },
        });
      } else {
        // Take + Place for empty destination
        actions.push(
          {
            type_id: 'take',
            count: sourceItem.count,
            source: {
              slot_type: { container_id: sourceContainer.containerId },
              slot: sourceContainer.slot,
              stack_id: (sourceItem as any).stackId || 0,
            },
            destination: {
              slot_type: { container_id: 'cursor' },
              slot: 0,
              stack_id: 0,
            },
          },
          {
            type_id: 'place',
            count: sourceItem.count,
            source: {
              slot_type: { container_id: 'cursor' },
              slot: 0,
              stack_id: (sourceItem as any).stackId || 0,
            },
            destination: {
              slot_type: { container_id: destContainer.containerId },
              slot: destContainer.slot,
              stack_id: 0,
            },
          }
        );
      }

      bot._client.write('item_stack_request', {
        requests: [{ request_id: requestId, actions, custom_names: [], cause: -1 }],
      });

      const success = await waitForResponse(requestId);
      if (!success) {
        throw new Error('Failed to move item');
      }
    }

    // Update local state after successful response
    // We use the captured counts (sourceCount/destCount) because
    // item_stack_response may have modified the item objects' count properties
    if (destItem) {
      // Swap: exchange items between source and dest, restoring original counts
      sourceItem.count = sourceCount;
      destItem.count = destCount;
      bot.inventory.updateSlot(sourceSlot, destItem);
      bot.inventory.updateSlot(destSlot, sourceItem);
    } else {
      // Move: item goes to dest, source becomes null
      sourceItem.count = sourceCount;
      bot.inventory.updateSlot(destSlot, sourceItem);
      bot.inventory.updateSlot(sourceSlot, null);
    }

    // Close inventory
    if (bot.currentWindow) {
      bot._client.write('container_close', {
        window_id: bot.currentWindow.id,
        window_type: 'none',
        server: false,
      });
      await onceWithCleanup(bot._client, 'container_close', 5000);
    }

    updateHeldItem();
  }

  function updateHeldItem(): void {
    bot.emit('heldItemChanged', bot.heldItem);
  }

  ////helpers

  function getSlotIndex(window_id: protocolTypes.WindowID, slot: number) {
    switch (window_id) {
      case 'inventory':
        return slot;
      case 'armor':
        return 36 + slot; // armor slots 36-39 (head, torso, legs, feet)
      case 'offhand':
        return 45 + slot; // offhand at slot 45 (Java compatibility)
      case 'hotbar':
        return slot;
      default:
        return slot;
        break;
    }
  }
  function getWindow(window_id: protocolTypes.WindowID): Window | null {
    let window: Window | null;
    if (window_id === 'inventory' || window_id === 'armor' || window_id === 'offhand' || window_id === 'hotbar' || window_id === 'fixed_inventory') {
      window = bot.inventory;
    } else if (window_id === 'ui') {
      return null;
    } else {
      // For container windows (chest, furnace, etc.), use currentWindow
      window = bot.currentWindow;
    }

    assert(!!window);
    return window;
  }

  /**
   * Get container ID for cursor-based operations (take/place through cursor).
   * Based on packet captures:
   * - Hotbar slots (0-8) use "hotbar" container
   * - Main inventory slots (9-35) use "inventory" container
   */
  function getContainerForCursorOp(slotIndex: number): {
    containerId: string;
    slot: number;
  } {
    if (slotIndex >= 0 && slotIndex <= 8) {
      // Hotbar slots use "hotbar" container
      return { containerId: 'hotbar', slot: slotIndex };
    } else if (slotIndex >= 9 && slotIndex <= 35) {
      // Main inventory uses "inventory" container
      return { containerId: 'inventory', slot: slotIndex };
    } else if (slotIndex >= 36 && slotIndex <= 39) {
      // Armor slots
      return { containerId: 'armor', slot: slotIndex - 36 };
    } else if (slotIndex === 45) {
      // Offhand
      return { containerId: 'offhand', slot: 1 };
    } else {
      throw new Error(`Invalid slot index for cursor op: ${slotIndex}`);
    }
  }

  function getContainerFromSlot(
    slotIndex: number,
    window?: Window
  ): {
    containerId: string;
    slot: number;
  } {
    // If we have a container window open, check if slot is in container section
    if (window && window !== bot.inventory && window.inventoryStart !== undefined) {
      if (slotIndex < window.inventoryStart) {
        // Container slot (e.g., chest slots 0-26)
        return { containerId: 'container', slot: slotIndex };
      }
      // Adjust slot index for player inventory section within container window
      // Window slots 27-62 map to player inventory
      const playerSlot = slotIndex - window.inventoryStart;
      if (playerSlot >= 0 && playerSlot <= 8) {
        return { containerId: 'hotbar', slot: playerSlot };
      } else if (playerSlot >= 9 && playerSlot <= 35) {
        // Main inventory
        return { containerId: 'inventory', slot: playerSlot };
      }
    }

    // Player inventory layout (Java compatible):
    // 0-8: hotbar (hotbar slots 0-8)
    // 9-35: main inventory (inventory slots 9-35)
    // 36-39: armor (armor slots 0-3: head, torso, legs, feet)
    // 45: offhand (offhand slot 0)

    if (slotIndex >= 0 && slotIndex <= 8) {
      // Hotbar
      return { containerId: 'hotbar', slot: slotIndex };
    } else if (slotIndex >= 9 && slotIndex <= 35) {
      // Main inventory
      return { containerId: 'inventory', slot: slotIndex };
    } else if (slotIndex >= 36 && slotIndex <= 39) {
      // Armor slots (head, torso, legs, feet)
      return { containerId: 'armor', slot: slotIndex - 36 };
    } else if (slotIndex === 45) {
      // Offhand (uses slot 1 in item_stack_request, not 0)
      return { containerId: 'offhand', slot: 1 };
    } else {
      throw new Error(`Invalid slot index: ${slotIndex}`);
    }
  }

  /**
   * Mode 1: Shift-click (quick transfer)
   * Transfers item from clicked slot to the opposite inventory section
   */
  async function clickWindowMode1(slot: number, window: Window): Promise<void> {
    const sourceItem = window.slots[slot];
    if (!sourceItem) return; // Nothing to transfer

    const sourceContainer = getContainerFromSlot(slot, window);
    const requestId = createActionNumber();

    // Determine destination based on source location and whether a container is open
    let destStart: number;
    let destEnd: number;

    if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
      // Container is open
      const containerSlots = window.inventoryStart ?? 27;

      if (slot < containerSlots) {
        // Source is in container section -> move to player inventory
        destStart = containerSlots;
        destEnd = window.inventoryEnd ?? 62;
      } else {
        // Source is in player inventory -> move to container
        destStart = 0;
        destEnd = containerSlots - 1;
      }
    } else {
      // No container open, use player inventory
      if (slot >= 0 && slot <= 8) {
        // Source is hotbar -> move to main inventory (9-35)
        destStart = 9;
        destEnd = 35;
      } else if (slot >= 9 && slot <= 35) {
        // Source is main inventory -> move to hotbar (0-8)
        destStart = 0;
        destEnd = 8;
      } else {
        // Source is armor/offhand -> move to main inventory
        destStart = 9;
        destEnd = 35;
      }
    }

    // Find destination slot (first empty or stackable)
    let destSlot: number | null = null;
    let destItem: Item | null = null;

    // First try to find a stackable slot
    if (sourceItem.stackSize > 1) {
      for (let i = destStart; i <= destEnd; i++) {
        const item = window.slots[i];
        if (item && item.type === sourceItem.type && item.metadata === sourceItem.metadata && item.count < item.stackSize) {
          destSlot = i;
          destItem = item;
          break;
        }
      }
    }

    // If no stackable slot, find first empty slot
    if (destSlot === null) {
      for (let i = destStart; i <= destEnd; i++) {
        if (!window.slots[i]) {
          destSlot = i;
          break;
        }
      }
    }

    if (destSlot === null) {
      return; // No room to transfer
    }

    const destContainer = getContainerFromSlot(destSlot, window);

    // Calculate how many items to transfer
    const spaceAvailable = destItem ? destItem.stackSize - destItem.count : sourceItem.stackSize;
    const transferCount = Math.min(sourceItem.count, spaceAvailable);

    // Use take + place actions for the transfer
    bot._client.write('item_stack_request', {
      requests: [
        {
          request_id: requestId,
          actions: [
            {
              type_id: 'take',
              count: transferCount,
              source: {
                slot_type: { container_id: sourceContainer.containerId },
                slot: sourceContainer.slot,
                stack_id: (sourceItem as any).stackId || 0,
              },
              destination: {
                slot_type: { container_id: 'cursor' },
                slot: 0,
                stack_id: 0,
              },
            },
            {
              type_id: 'place',
              count: transferCount,
              source: {
                slot_type: { container_id: 'cursor' },
                slot: 0,
                stack_id: (sourceItem as any).stackId || 0,
              },
              destination: {
                slot_type: { container_id: destContainer.containerId },
                slot: destContainer.slot,
                stack_id: destItem ? (destItem as any).stackId || 0 : 0,
              },
            },
          ],
          custom_names: [],
          cause: -1,
        },
      ],
    });

    const success = await waitForResponse(requestId);
    if (success) {
      // Update local state
      if (transferCount >= sourceItem.count) {
        window.updateSlot(slot, null);
      } else {
        sourceItem.count -= transferCount;
        window.updateSlot(slot, sourceItem);
      }

      if (destItem) {
        destItem.count += transferCount;
        window.updateSlot(destSlot, destItem);
      } else {
        const newItem = Object.assign(Object.create(Object.getPrototypeOf(sourceItem)), sourceItem);
        newItem.count = transferCount;
        newItem.slot = destSlot;
        window.updateSlot(destSlot, newItem);
      }
    }
  }

  /**
   * Mode 2: Number key swap (hotbar swap)
   * Swaps item in clicked slot with hotbar slot indicated by mouseButton (0-8)
   */
  async function clickWindowMode2(slot: number, mouseButton: number, window: Window): Promise<void> {
    assert.ok(mouseButton >= 0 && mouseButton <= 8, 'mouseButton must be 0-8 for mode 2');

    const hotbarSlot = mouseButton; // 0-8
    const sourceItem = window.slots[slot];
    const hotbarItem = window.slots[hotbarSlot];

    // Don't swap with self
    if (slot === hotbarSlot) return;

    const sourceContainer = getContainerFromSlot(slot, window);
    const hotbarContainer = getContainerFromSlot(hotbarSlot, window);
    const requestId = createActionNumber();

    if (!sourceItem && !hotbarItem) {
      return; // Both slots empty, nothing to do
    }

    let actions: any[];

    if (sourceItem && hotbarItem) {
      // Both slots have items - swap
      actions = [
        {
          type_id: 'swap',
          source: {
            slot_type: { container_id: sourceContainer.containerId },
            slot: sourceContainer.slot,
            stack_id: (sourceItem as any).stackId || 0,
          },
          destination: {
            slot_type: { container_id: hotbarContainer.containerId },
            slot: hotbarContainer.slot,
            stack_id: (hotbarItem as any).stackId || 0,
          },
        },
      ];
    } else if (sourceItem) {
      // Only source has item - move to hotbar
      actions = [
        {
          type_id: 'take',
          count: sourceItem.count,
          source: {
            slot_type: { container_id: sourceContainer.containerId },
            slot: sourceContainer.slot,
            stack_id: (sourceItem as any).stackId || 0,
          },
          destination: {
            slot_type: { container_id: 'cursor' },
            slot: 0,
            stack_id: 0,
          },
        },
        {
          type_id: 'place',
          count: sourceItem.count,
          source: {
            slot_type: { container_id: 'cursor' },
            slot: 0,
            stack_id: (sourceItem as any).stackId || 0,
          },
          destination: {
            slot_type: { container_id: hotbarContainer.containerId },
            slot: hotbarContainer.slot,
            stack_id: 0,
          },
        },
      ];
    } else {
      // Only hotbar has item - move to clicked slot
      actions = [
        {
          type_id: 'take',
          count: hotbarItem!.count,
          source: {
            slot_type: { container_id: hotbarContainer.containerId },
            slot: hotbarContainer.slot,
            stack_id: (hotbarItem as any).stackId || 0,
          },
          destination: {
            slot_type: { container_id: 'cursor' },
            slot: 0,
            stack_id: 0,
          },
        },
        {
          type_id: 'place',
          count: hotbarItem!.count,
          source: {
            slot_type: { container_id: 'cursor' },
            slot: 0,
            stack_id: (hotbarItem as any).stackId || 0,
          },
          destination: {
            slot_type: { container_id: sourceContainer.containerId },
            slot: sourceContainer.slot,
            stack_id: 0,
          },
        },
      ];
    }

    bot._client.write('item_stack_request', {
      requests: [
        {
          request_id: requestId,
          actions,
          custom_names: [],
          cause: -1,
        },
      ],
    });

    const success = await waitForResponse(requestId);
    if (success) {
      // Update local state
      window.updateSlot(slot, hotbarItem);
      window.updateSlot(hotbarSlot, sourceItem);
    }
  }

  /**
   * Mode 3: Creative clone (middle-click)
   * Clones item from slot to cursor with full stack
   * Only works in creative mode
   */
  async function clickWindowMode3(slot: number, window: Window): Promise<void> {
    // Only works in creative mode
    if (bot.game?.gameMode !== 'creative') {
      throw new Error('Mode 3 (creative clone) only works in creative mode');
    }

    const sourceItem = window.slots[slot];
    if (!sourceItem) return; // Nothing to clone

    const requestId = createActionNumber();

    // In Bedrock creative mode, we use a 'create' action to clone items
    // The item is created directly in the cursor with max stack size
    const sourceContainer = getContainerFromSlot(slot, window);

    bot._client.write('item_stack_request', {
      requests: [
        {
          request_id: requestId,
          actions: [
            {
              type_id: 'create',
              results_slot: 0, // Result goes to cursor
            },
            {
              type_id: 'place',
              count: sourceItem.stackSize || 64,
              source: {
                slot_type: { container_id: 'created_output' },
                slot: 0,
                stack_id: 0,
              },
              destination: {
                slot_type: { container_id: 'cursor' },
                slot: 0,
                stack_id: 0,
              },
            },
          ],
          custom_names: [],
          cause: -1,
        },
      ],
    });

    const success = await waitForResponse(requestId);
    if (success) {
      // Clone item to cursor with max stack
      const clonedItem = new Item(sourceItem.type, sourceItem.stackSize || 64, sourceItem.metadata, sourceItem.nbt);
      cursorItem = clonedItem;
    }
  }

  /**
   * Mode 4: Q key drop
   * mouseButton 0: Drop 1 item from slot
   * mouseButton 1: Drop entire stack from slot (Ctrl+Q)
   */
  async function clickWindowMode4(slot: number, mouseButton: number, window: Window): Promise<void> {
    const sourceItem = window.slots[slot];
    if (!sourceItem) return; // Nothing to drop

    const sourceContainer = getContainerFromSlot(slot, window);
    const requestId = createActionNumber();

    // mouseButton 0 = drop 1, mouseButton 1 = drop all (Ctrl+Q)
    const dropCount = mouseButton === 1 ? sourceItem.count : 1;

    bot._client.write('item_stack_request', {
      requests: [
        {
          request_id: requestId,
          actions: [
            {
              type_id: 'drop',
              count: dropCount,
              source: {
                slot_type: { container_id: sourceContainer.containerId },
                slot: sourceContainer.slot,
                stack_id: (sourceItem as any).stackId || 0,
              },
              randomly: false,
            },
          ],
          custom_names: [],
          cause: -1,
        },
      ],
    });

    const success = await waitForResponse(requestId);
    if (success) {
      if (dropCount >= sourceItem.count) {
        window.updateSlot(slot, null);
      } else {
        sourceItem.count -= dropCount;
        window.updateSlot(slot, sourceItem);
      }
    }
  }

  function waitForResponse(requestId: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        bot.removeListener(`itemStackResponse:${requestId}`, listener);
        resolve(false);
      }, 500000); // 5 second timeout

      const listener = async (success: boolean) => {
        clearTimeout(timeout);
        // Wait for server to finish processing
        await new Promise((r) => setTimeout(r, 100));
        resolve(success);
      };

      bot.once(`itemStackResponse:${requestId}`, listener);
    });
  }

  function onceWithCleanup(source: EventEmitter, name: string, timeoutMs: number = 10000): Promise<boolean> {
    return new Promise<any>((resolve) => {
      const timeout = setTimeout(() => {
        source.removeListener(name, listener);
        resolve(false);
      }, timeoutMs); // 5 second timeout

      const listener = (...params) => {
        clearTimeout(timeout);
        resolve(params);
      };

      source.once(name, listener);
    });
  }

  /**
   * Deposit items from player inventory to container
   * Uses item_stack_request with cross-window transfer
   */
  async function depositToContainer(containerWindow: Window, itemType: number, metadata: number | null, count: number | null, nbt: object | null | undefined, containerSlots: number): Promise<void> {
    const totalToTransfer = count ?? 64;
    let transferred = 0;
    const maxStackSize = bot.registry.itemsArray.find((x: any) => x.id === itemType)?.stackSize ?? 64;

    while (transferred < totalToTransfer) {
      // Find item in player inventory (re-find each iteration as slots change)
      const sourceItem = bot.inventory.findItemRange(0, 36, itemType, metadata, false, nbt);
      if (!sourceItem) {
        if (transferred === 0) {
          const mcDataEntry = bot.registry.itemsArray.find((x: any) => x.id === itemType);
          throw new Error(`Can't find ${mcDataEntry?.name || itemType} in player inventory`);
        }
        break; // No more items to transfer
      }

      // Find destination slot in container
      let destSlot: number | null = null;
      let destStackId = 0;
      let destCurrentCount = 0;
      // First try to stack with existing items
      const existingItem = containerWindow.findItemRange(0, containerSlots, itemType, metadata, true, nbt);
      if (existingItem) {
        destSlot = existingItem.slot;
        destStackId = (existingItem as any).stackId || 0;
        destCurrentCount = existingItem.count;
      } else {
        destSlot = containerWindow.firstEmptySlotRange(0, containerSlots);
        destCurrentCount = 0;
      }

      if (destSlot === null) {
        if (transferred === 0) {
          throw new Error('Container is full');
        }
        break; // Container full, but we transferred some
      }

      // Calculate how many items to transfer in this batch
      const availableInDest = maxStackSize - destCurrentCount;
      const remainingToTransfer = totalToTransfer - transferred;
      const availableInSource = sourceItem.count;
      const transferCount = Math.min(availableInDest, remainingToTransfer, availableInSource);

      if (transferCount <= 0) {
        // Destination stack is full, find another slot
        destSlot = containerWindow.firstEmptySlotRange(0, containerSlots);
        if (destSlot === null) {
          break; // Container full
        }
        destStackId = 0;
        destCurrentCount = 0;
        continue;
      }

      const stackId = (sourceItem as any).stackId || 0;
      const sourceContainer = getContainerFromSlot(sourceItem.slot, bot.inventory);

      // Step 1: Take items from inventory to cursor
      const takeRequestId = createActionNumber();
      let cursorStackId = stackId;

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

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: takeRequestId,
            actions: [
              {
                type_id: 'take',
                count: transferCount,
                source: {
                  slot_type: { container_id: sourceContainer.containerId },
                  slot: sourceContainer.slot,
                  stack_id: stackId,
                },
                destination: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: 0,
                },
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      let success = await waitForResponse(takeRequestId);
      bot._client.removeListener('item_stack_response', takeResponseHandler);

      if (!success) {
        throw new Error('Deposit failed - take rejected');
      }

      // Step 2: Place items from cursor to container
      const placeRequestId = createActionNumber();

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: placeRequestId,
            actions: [
              {
                type_id: 'place',
                count: transferCount,
                source: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: cursorStackId,
                },
                destination: {
                  slot_type: { container_id: 'container' },
                  slot: destSlot,
                  stack_id: destStackId,
                },
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      success = await waitForResponse(placeRequestId);

      if (!success) {
        throw new Error('Deposit failed - place rejected');
      }

      transferred += transferCount;

      // Note: State updates are handled by item_stack_response handler
      // which receives authoritative counts from the server

      // Create new item in container slot if needed (item_stack_response doesn't know item type)
      const existingDestItem = containerWindow.slots[destSlot];
      if (!existingDestItem) {
        const newItem = Object.assign(Object.create(Object.getPrototypeOf(sourceItem)), sourceItem);
        newItem.count = transferCount;
        newItem.slot = destSlot;
        (newItem as any).stackId = destStackId;
        containerWindow.updateSlot(destSlot, newItem);
      }
    }
  }

  /**
   * Withdraw items from container to player inventory
   * Uses item_stack_request with cross-window transfer
   */
  async function withdrawFromContainer(
    containerWindow: Window,
    itemType: number,
    metadata: number | null,
    count: number | null,
    nbt: object | null | undefined,
    containerSlots: number
  ): Promise<void> {
    const totalToTransfer = count ?? 64;
    let transferred = 0;
    const maxStackSize = bot.registry.itemsArray.find((x: any) => x.id === itemType)?.stackSize ?? 64;

    while (transferred < totalToTransfer) {
      // Find item in container (re-find each iteration as slots change)
      const sourceItem = containerWindow.findItemRange(0, containerSlots, itemType, metadata, false, nbt);
      if (!sourceItem) {
        if (transferred === 0) {
          const mcDataEntry = bot.registry.itemsArray.find((x: any) => x.id === itemType);
          throw new Error(`Can't find ${mcDataEntry?.name || itemType} in container`);
        }
        break; // No more items to withdraw
      }

      // Find destination slot in player inventory
      let destSlot: number | null = null;
      let destStackId = 0;
      let destCurrentCount = 0;
      // First try to stack with existing items (hotbar + inventory)
      const existingItem = bot.inventory.findItemRange(0, 36, itemType, metadata, true, nbt);
      if (existingItem) {
        destSlot = existingItem.slot;
        destStackId = (existingItem as any).stackId || 0;
        destCurrentCount = existingItem.count;
      } else {
        destSlot = bot.inventory.firstEmptySlotRange(0, 36);
        destCurrentCount = 0;
      }

      if (destSlot === null) {
        if (transferred === 0) {
          throw new Error('Player inventory is full');
        }
        break; // Inventory full, but we transferred some
      }

      // Calculate how many items to transfer in this batch
      const availableInDest = maxStackSize - destCurrentCount;
      const remainingToTransfer = totalToTransfer - transferred;
      const availableInSource = sourceItem.count;
      const transferCount = Math.min(availableInDest, remainingToTransfer, availableInSource);

      if (transferCount <= 0) {
        // Destination stack is full, find another slot
        destSlot = bot.inventory.firstEmptySlotRange(0, 36);
        if (destSlot === null) {
          break; // Inventory full
        }
        destStackId = 0;
        destCurrentCount = 0;
        continue;
      }

      const stackId = (sourceItem as any).stackId || 0;
      const destContainer = getContainerFromSlot(destSlot, bot.inventory);

      // Step 1: Take items from container to cursor
      const takeRequestId = createActionNumber();
      let cursorStackId = stackId;

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

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: takeRequestId,
            actions: [
              {
                type_id: 'take',
                count: transferCount,
                source: {
                  slot_type: { container_id: 'container' },
                  slot: sourceItem.slot,
                  stack_id: stackId,
                },
                destination: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: 0,
                },
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      let success = await waitForResponse(takeRequestId);
      bot._client.removeListener('item_stack_response', takeResponseHandler);

      if (!success) {
        throw new Error('Withdraw failed - take rejected');
      }

      // Step 2: Place items from cursor to inventory
      const placeRequestId = createActionNumber();

      bot._client.write('item_stack_request', {
        requests: [
          {
            request_id: placeRequestId,
            actions: [
              {
                type_id: 'place',
                count: transferCount,
                source: {
                  slot_type: { container_id: 'cursor' },
                  slot: 0,
                  stack_id: cursorStackId,
                },
                destination: {
                  slot_type: { container_id: destContainer.containerId },
                  slot: destContainer.slot,
                  stack_id: destStackId,
                },
              },
            ],
            custom_names: [],
            cause: -1,
          },
        ],
      });

      success = await waitForResponse(placeRequestId);

      if (!success) {
        throw new Error('Withdraw failed - place rejected');
      }

      transferred += transferCount;

      // Note: State updates are handled by item_stack_response handler
      // which receives authoritative counts from the server

      // Create new item in player inventory slot if needed (item_stack_response doesn't know item type)
      const existingDestItem = bot.inventory.slots[destSlot];
      if (!existingDestItem) {
        const newItem = Object.assign(Object.create(Object.getPrototypeOf(sourceItem)), sourceItem);
        newItem.count = transferCount;
        newItem.slot = destSlot;
        (newItem as any).stackId = destStackId;
        bot.inventory.updateSlot(destSlot, newItem);
      }
    }
  }
}
