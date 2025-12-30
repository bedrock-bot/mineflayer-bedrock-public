import type { Block } from "prismarine-block";
import type { Bot, TransferOptions } from "../../index.js";
import type { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import windowLoader, {
  type Window,
  type WindowsExports,
} from "prismarine-windows";
import type { EventEmitter } from "events";
import itemLoader, { type Item } from "prismarine-item";
import type { protocolTypes } from "../../bedrock-types.js";
import assert from "assert";

const QUICK_BAR_COUNT = 9;
const QUICK_BAR_START = 36;

let nextRequestId = -1;

export default function inject(bot: Bot) {
  bot.activateBlock = activateBlock;
  bot.activateEntity = activateEntity;
  bot.activateEntityAt = activateEntityAt;
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

  const Item = (itemLoader as any)(bot.registry) as typeof Item;
  const windows = (windowLoader as any)(bot.registry) as WindowsExports;

  bot.quickBarSlot = null;
  bot.inventory = windows.createWindow(0, "minecraft:inventory", "Inventory");
  bot.inventory.hotbarStart = 0; // first 9 slots are crafting grid


  bot.currentWindow = null;
  bot.heldItem = null;
  bot.usingHeldItem = false;

  Object.defineProperty(bot, "heldItem", {
    get: function () {
      return bot.inventory.slots[QUICK_BAR_START + bot.quickBarSlot];
    },
  });

  bot.on("heldItemChanged", (heldItem: Item | null) => {});

  bot._client.on(
    "inventory_slot",
    (packet: protocolTypes.packet_inventory_slot) => {
      // if (bot.item_registry_task) {
      //   bot.item_registry_task.promise.then(handle);
      // } else {
      //   handle();
      // }

      // function handle() {
      //   let window = getWindow(packet.window_id);
      //   if (!window) return;

      //   const newItem = Item.fromNotch(packet.item);
      //   const slotIndex = getSlotIndex(packet.window_id, packet.slot);
      //   window.updateSlot(slotIndex, newItem);
      //   updateHeldItem();
      // }
    }
  );

  bot._client.on(
    "inventory_transaction",
    (packet: protocolTypes.packet_inventory_transaction) => {
      // const transaction = packet.transaction;
      // if (bot.item_registry_task) {
      //   bot.item_registry_task.promise.then(handle);
      // } else {
      //   handle();
      // }
      // function handle() {
      //   for (const action of transaction.actions) {
      //     if (action.source_type === "container") {
      //       let window = getWindow(action.inventory_id);
      //       const newItem = Item.fromNotch(action.new_item);
      //       const slotIndex = getSlotIndex(action.inventory_id, action.slot);
      //       window.updateSlot(slotIndex, newItem);
      //       updateHeldItem();
      //     } else if (
      //       action.source_type === "world_interaction" ||
      //       action.source_type === "creative"
      //     ) {
      //     } else {
      //       assert(false);
      //     }
      //   }
      // }
    }
  );
  bot._client.on(
    "inventory_content",
    (packet: protocolTypes.packet_inventory_content) => {
      const window = getWindow(packet.window_id);
      if (!window) return;

      if(packet.window_id === 'inventory'){
        for (let i = 0; i < packet.input.length; i++) {
          const newItem = Item.fromNotch(packet.input[i]);
          //const slotIndex = getSlotIndex(packet.window_id === 'inventory' && i <=8 ? 'hotbar':'inventory', i);
          window.updateSlot(i, newItem);
        }
      }else{
        for (let i = 0; i < packet.input.length; i++) {
          const newItem = Item.fromNotch(packet.input[i]);
          const slotIndex = getSlotIndex(packet.window_id, i);
          window.updateSlot(slotIndex, newItem);
        }
      }


      // Update held item reference
      updateHeldItem();

      // Emit event to signal window items have been set
      bot.emit(`setWindowItems:${window.id}`);
    }
  );

  bot._client.on(
    "player_hotbar",
    (packet: protocolTypes.packet_player_hotbar) => {
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
    }
  );

  bot._client.on("play_status", (packet: protocolTypes.packet_play_status) => {
    if (packet.status === "player_spawn") {
      // After receiving player_spawn, we need to send 2 mob_equipment packets
      // 1. For the active hotbar item
      // 2. For the offhand item

      // Default to slot 0 if quickBarSlot is not set yet
      const selectedSlot = getSlotIndex("inventory", bot.quickBarSlot ?? 0);

      // Send mob_equipment for active hotbar item
      const hotbarItem = bot.inventory.slots[selectedSlot];
      bot._client.write("mob_equipment", {
        runtime_entity_id: bot.entity.id,
        item: hotbarItem ? Item.toNotch(hotbarItem, 0) : { network_id: 0 },
        slot: selectedSlot,
        selected_slot: selectedSlot,
        window_id: "inventory",
      });

      // Send mob_equipment for offhand item
      const offhandItem = bot.inventory.slots[45]; // offhand slot
      bot._client.write("mob_equipment", {
        runtime_entity_id: bot.entity.id,
        item: offhandItem ? Item.toNotch(offhandItem, 0) : { network_id: 0 },
        slot: 1,
        selected_slot: 0,
        window_id: "offhand",
      });
    }
  });

  bot._client.on(
    "container_open",
    (packet: protocolTypes.packet_container_open) => {
      // Map Bedrock window types to prismarine-windows compatible types
      const windowTypeMap: Record<string, string> = {
        container: "minecraft:generic_9x3", // Default chest
        workbench: "minecraft:crafting_table",
        furnace: "minecraft:furnace",
        enchantment: "minecraft:enchantment",
        brewing_stand: "minecraft:brewing_stand",
        anvil: "minecraft:anvil",
        dispenser: "minecraft:dispenser",
        dropper: "minecraft:dropper",
        hopper: "minecraft:hopper",
        beacon: "minecraft:beacon",
        loom: "minecraft:loom",
        grindstone: "minecraft:grindstone",
        blast_furnace: "minecraft:blast_furnace",
        smoker: "minecraft:smoker",
        stonecutter: "minecraft:stonecutter",
        horse: "EntityHorse",
        inventory: "minecraft:inventory",
      };

      const windowType =
        windowTypeMap[packet.window_type] || "minecraft:generic_9x3";

      // Create a new window for this container
      bot.currentWindow = windows.createWindow(
        packet.window_id,
        windowType,
        packet.window_type, // Use window_type as title for now
        undefined // slotCount will be determined by window type
      );

      // Wait for inventory_content packet to populate the window before emitting windowOpen
      bot.once(`setWindowItems:${bot.currentWindow.id}`, () => {
        bot.emit("windowOpen", bot.currentWindow);
      });
    }
  );

  bot._client.on(
    "item_stack_response",
    (packet: protocolTypes.packet_item_stack_response) => {
      // Process each response in the packet
      for (const response of packet.responses) {
        const { status, request_id, containers } = response;

        if (status === "ok") {
          // Process successful response - update window slots based on container data
          if (containers) {
            for (const container of containers) {
              const containerId = container.slot_type?.container_id;

              // Determine which window to update based on container_id
              let window: Window | null = null;

              if (
                containerId === "inventory" ||
                containerId === "hotbar" ||
                containerId === "crafting_input" ||
                containerId === "crafting_output"
              ) {
                window = bot.inventory;
              } else if (containerId === "cursor") {
                // Cursor updates affect the selectedItem
                if (container.slots && container.slots.length > 0) {
                  const cursorSlot = container.slots[0];
                  if (
                    cursorSlot.count === 0 ||
                    cursorSlot.item_stack_id === 0
                  ) {
                    bot.inventory.selectedItem = null;
                  } else {
                    // Note: We would need item data to properly create the selectedItem
                    // For now, we'll trust that inventory_slot or inventory_transaction
                    // packets will update the actual slots
                  }
                }
                continue;
              } else if (bot.currentWindow) {
                window = bot.currentWindow;
              }

              if (!window) continue;

              // Update each slot in the container
              if (container.slots) {
                for (const slotData of container.slots) {
                  const slot = slotData.slot;

                  // Note: The item_stack_response doesn't contain full item data
                  // (like item type, metadata, NBT), only stack_id and count.
                  // The actual item updates come from inventory_slot or inventory_transaction packets.
                  // We mainly use this to confirm the transaction succeeded.

                  // Store the item_stack_id on the item if it exists
                  if (window.slots[slot]) {
                    (window.slots[slot] as any).stackId =
                      slotData.item_stack_id;
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
    }
  );

  bot._client.on(
    "container_close",
    (packet: protocolTypes.packet_container_close) => {
      // Close the container window
      const oldWindow = bot.currentWindow;

      if (oldWindow && oldWindow.id === packet.window_id) {
        bot.currentWindow = null;
        bot.emit("windowClose", oldWindow);
      }
    }
  );

  ////////////////////////////////////////////////////////////////

  async function activateBlock(
    block: Block,
    direction?: Vec3,
    cursorPos?: Vec3
  ) {
    //
  }

  async function activateEntity(entity: Entity): Promise<void> {
    //
  }

  async function activateEntityAt(
    entity: Entity,
    position: Vec3
  ): Promise<void> {
    //
  }

  async function consume(): Promise<void> {
    //
  }

  function activateItem(offhand?: boolean) {
    //
  }

  function deactivateItem() {
    //
  }

  async function clickWindow(
    slot: number,
    mouseButton: number,
    mode: number
  ): Promise<void> {}

  async function putSelectedItemRange(
    start: number,
    end: number,
    window: Window,
    slot: any
  ): Promise<void> {
    //
  }

  async function putAway(slot: number): Promise<void> {
    //
  }

  function closeWindow(window: Window): void {
    //
  }

  async function transfer(options: TransferOptions): Promise<void> {
    //
  }

  async function openBlock(
    block: Block,
    direction?: Vec3,
    cursorPos?: Vec3
  ): Promise<Window> {
    throw new Error("openBlock is not implemented");
  }

  async function openEntity(
    entity: Entity,
    Class: new () => EventEmitter
  ): Promise<Window> {
    throw new Error("openEntity is not implemented");
  }

  async function moveSlotItem(
    sourceSlot: number,
    destSlot: number
  ): Promise<void> {
    // Get the item at the source slot to get its stack_id
    const sourceItem = bot.inventory.slots[sourceSlot];
    if (!sourceItem) {
      throw new Error(`No item at source slot ${sourceSlot}`);
    }

    const sourceStackId = (sourceItem as any).stackId || 0;

    // Convert slot indices to Bedrock window_id + slot format
    const sourceContainer = getContainerFromSlot(sourceSlot);
    const destContainer = getContainerFromSlot(destSlot);

    // Generate unique request IDs (use negative numbers like in packet captures)
    const takeRequestId = --nextRequestId;
    const placeRequestId = --nextRequestId;

    // Step 1: Take item from source to cursor
    const takeRequest = {
      requests: [
        {
          request_id: takeRequestId,
          actions: [
            {
              type_id: "take",
              count: sourceItem.count,
              source: {
                slot_type: {
                  container_id: sourceContainer.containerId,
                },
                slot: sourceContainer.slot,
                stack_id: sourceStackId,
              },
              destination: {
                slot_type: {
                  container_id: "cursor",
                },
                slot: 0,
                stack_id: 0,
              },
            },
          ],
          custom_names: [],
          cause: -1,
        },
      ],
    };

    // Send take request
    bot._client.write("item_stack_request", takeRequest);

    // Wait for response
    const takeSuccess = await waitForResponse(takeRequestId);
    if (!takeSuccess) {
      throw new Error("Failed to take item from source slot");
    }

    // Step 2: Place item from cursor to destination
    const placeRequest = {
      requests: [
        {
          request_id: placeRequestId,
          actions: [
            {
              type_id: "place",
              count: sourceItem.count,
              source: {
                slot_type: {
                  container_id: "cursor",
                },
                slot: 0,
                stack_id: sourceStackId,
              },
              destination: {
                slot_type: {
                  container_id: destContainer.containerId,
                },
                slot: destContainer.slot,
                stack_id: 0,
              },
            },
          ],
          custom_names: [],
          cause: -1,
        },
      ],
    };

    // Send place request
    bot._client.write("item_stack_request", placeRequest);

    // Wait for response
    const placeSuccess = await waitForResponse(placeRequestId);
    if (!placeSuccess) {
      throw new Error("Failed to place item at destination slot");
    }

    updateHeldItem();
  }

  function updateHeldItem(): void {
    bot.emit("heldItemChanged", bot.heldItem);
  }

  ////helpers

  function getSlotIndex(window_id: protocolTypes.WindowID, slot: number) {
    switch (window_id) {
      case "inventory":
        return slot;
      case "armor":
        return 36 + slot;
      case "offhand":
        return 45 + slot;
      case "hotbar":
        return slot;
      default:
        break;
    }
  }
  function getWindow(window_id: protocolTypes.WindowID): Window | null {
    let window: Window | null;
    if (
      window_id === "inventory" ||
      window_id === "armor" ||
      window_id === "offhand" ||
      window_id === "hotbar" ||
      window_id === "fixed_inventory"
    ) {
      window = bot.inventory;
    } else if (window_id === "ui") {
      return null;
    } else {
      // For container windows (chest, furnace, etc.), use currentWindow
      window = bot.currentWindow;
    }

    assert(!!window);
    return window;
  }

  function getContainerFromSlot(slotIndex: number): {
    containerId: string;
    slot: number;
  } {
    // Bedrock inventory layout:
    // 0-8: hotbar (hotbar slots 0-8)
    // 9-35: main inventory (inventory slots 9-35)
    // 36-39: armor (armor slots 0-3)
    // 40: offhand (offhand slot 0)
    // 41-44: crafting input (crafting_input slots 0-3)
    // 45: crafting output (crafting_output slot 0)

    if (slotIndex >= 0 && slotIndex <= 8) {
      // Hotbar
      return { containerId: "hotbar", slot: slotIndex };
    } else if (slotIndex >= 9 && slotIndex <= 35) {
      // Main inventory
      return { containerId: "inventory", slot: slotIndex };
    } else if (slotIndex >= 36 && slotIndex <= 39) {
      // Armor slots
      return { containerId: "armor", slot: slotIndex - 36 };
    } else if (slotIndex === 45) {
      // Offhand
      return { containerId: "offhand", slot: 0 };
    } else {
      throw new Error(`Invalid slot index: ${slotIndex}`);
    }
  }

  function waitForResponse(requestId: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        bot.removeListener(`itemStackResponse:${requestId}`, listener);
        resolve(false);
      }, 5000); // 5 second timeout

      const listener = (success: boolean) => {
        clearTimeout(timeout);
        resolve(success);
      };

      bot.once(`itemStackResponse:${requestId}`, listener);
    });
  }
}
