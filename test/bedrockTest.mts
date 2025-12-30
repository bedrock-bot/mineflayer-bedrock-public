import { type Player, Server, type Version } from "bedrock-protocol";
import registryLoader, { type RegistryBedrock } from "prismarine-registry";
import type { Bot } from "../index.js";
import mineflayer from "../index.js";
import { expect } from "expect";
import {
  getDataBuilder,
  startServer,
  waitForClientConnect,
  initializeClient,
} from "mineflayer-bedrock-server";

function connectToServer(version) {
  return mineflayer.createBot({
    host: "127.0.0.1",
    port: 25567,
    version: `bedrock_${version}`,
    auth: "offline",
    username: "BedrockBot",
    offline: true,
  });
}

const testedVersions: Version[] = ["1.21.130"];
for (const supportedVersion of testedVersions) {
  describe(`mineflayer_internal ${supportedVersion}v`, function () {
    this.timeout(1000 * 1000);

    let bot: Bot | null = null;
    let server: Server | null = null;
    let client: Player | null = null;

    let registry = registryLoader(
      `bedrock_${supportedVersion}`
    ) as RegistryBedrock;

    // Test that the bot sends the correct mob_equipment packets after receiving play_status
    it("sends correct mob_equipment packets after play_status", async () => {
      const dataBuilder = getDataBuilder("1.21.130");
      dataBuilder.setInventoryItem(0, "netherite_sword", 1, 1001);
      dataBuilder.setInventoryItem(1, "netherite_chestplate", 1, 1002);
      dataBuilder.setInventoryItem(2, "netherite_leggings", 1, 1003);
      dataBuilder.setInventoryItem(3, "netherite_sword", 1, 1004);
      dataBuilder.setInventoryItem(8, "netherite_sword", 1, 1005);
      dataBuilder.setInventoryItem(9, "jungle_log", 64, 1006);
      dataBuilder.setOffhandSlot("shield", 1007);

      const mob_equipment_packets = [];
      registry.handleItemRegistry(dataBuilder.data.item_registry);
      server = await startServer("127.0.0.1", 25567, supportedVersion);
      setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
      client = await waitForClientConnect(server);
      client.on("mob_equipment", (x) => {
        mob_equipment_packets.push(x);
      });

      await initializeClient(client, dataBuilder.data);

      expect(mob_equipment_packets).toHaveLength(2);

      expect(mob_equipment_packets[0]).toEqual(
        dataBuilder.normalizePacket("mob_equipment", {
          item: dataBuilder.toNotch("netherite_sword", 1, undefined),
          runtime_entity_id: 25n,
          selected_slot: 0,
          slot: 0,
          window_id: "inventory",
        })
      );

      expect(mob_equipment_packets[1]).toEqual(
        dataBuilder.normalizePacket("mob_equipment", {
          item: dataBuilder.toNotch("shield", 1, undefined),
          runtime_entity_id: 25n,
          selected_slot: 0,
          slot: 1,
          window_id: "offhand",
        })
      );
    });

    it("should load invenory items", async () => {
      const dataBuilder = getDataBuilder("1.21.130");

      for(let slot = 0; slot <36; slot++){
        const count = slot+1;
        dataBuilder.setInventoryItem(slot, "jungle_log", count, 1000+slot);
      }

      dataBuilder.setOffhandSlot("shield", 1007);

      const mob_equipment_packets = [];
      registry.handleItemRegistry(dataBuilder.data.item_registry);
      server = await startServer("127.0.0.1", 25567, supportedVersion);
      setTimeout(() => (bot = connectToServer(supportedVersion)), 50);
      client = await waitForClientConnect(server);
      client.on("mob_equipment", (x) => {
        mob_equipment_packets.push(x);
      });

      await initializeClient(client, dataBuilder.data);

      const actual = bot.inventory.slots.map(x=>`${x?.count-1} ${x?.name}`.trim());
      expect(actual).toEqual([
         "0 jungle_log",
        "1 jungle_log",
        "2 jungle_log",
        "3 jungle_log",
        "4 jungle_log",
        "5 jungle_log",
        "6 jungle_log",
        "7 jungle_log",
        "8 jungle_log",
        "9 jungle_log",
        "10 jungle_log",
        "11 jungle_log",
        "12 jungle_log",
        "13 jungle_log",
        "14 jungle_log",
        "15 jungle_log",
        "16 jungle_log",
        "17 jungle_log",
        "18 jungle_log",
        "19 jungle_log",
        "20 jungle_log",
        "21 jungle_log",
        "22 jungle_log",
        "23 jungle_log",
        "24 jungle_log",
        "25 jungle_log",
        "26 jungle_log",
        "27 jungle_log",
        "28 jungle_log",
        "29 jungle_log",
        "30 jungle_log",
        "31 jungle_log",
        "32 jungle_log",
        "33 jungle_log",
        "34 jungle_log",
        "35 jungle_log",
        "0 netherite_helmet",
        "0 netherite_chestplate",
        "0 netherite_leggings",
        "0 netherite_boots",
        "NaN undefined",
        "NaN undefined",
        "NaN undefined",
        "NaN undefined",
        "NaN undefined",
        "0 shield"
      ]);

    });

    afterEach(async () => {
      if (server) {
        await server.close();
        server = null;
      }
    });
  });
}

// /* eslint-env mocha */
// const mineflayer = require('../')
// const assert = require('assert')
// const path = require('path')
// const { expect } = require('expect')

// // Test Bedrock Edition specific functionality
// describe('mineflayer_bedrock', function () {
//   this.timeout(10 * 1000 * 1000)

//   describe('inventory', () => {
//     // Test that the bot sends the correct mob_equipment packets after receiving play_status
//     // This validates inventory.mts:120-148 which sends equipment updates on spawn
//     it('sends correct mob_equipment packets after play_status', (done) => {
//       // Path to the binary packet dump file
//       const packetDumpPath = path.join(__dirname, '../../mineflayer-bedrock/dumps/1.21.130-1766996035755 - activate hotbar slot.bin')

//       // Track mob_equipment packets sent by the bot
//       const mobEquipmentPackets = []
//       let expectedPackets = 2 // We expect 2 mob_equipment packets

//       // Create bot with replay client
//       const { createReplayClient } = require('../../mineflayer-bedrock/src/bedrock-replay-protocol/index.ts')
//       const replayClient = createReplayClient(packetDumpPath, true)

//       // Intercept write calls to capture mob_equipment packets
//       const originalWrite = replayClient.write.bind(replayClient)
//       replayClient.write = (packetName, data) => {
//         if (packetName === 'mob_equipment') {
//           mobEquipmentPackets.push(data)

//           // Check if we've received all expected packets
//           if (mobEquipmentPackets.length === expectedPackets) {
//             // Wait a tick to ensure no more packets are sent
//             setImmediate(() => {
//               try {
//                 // Verify we have exactly 2 mob_equipment packets
//                 assert.strictEqual(mobEquipmentPackets.length, 2, 'Should send exactly 2 mob_equipment packets')

//                 // First packet: inventory slot with iron sword (network_id 261)
//                 const firstPacket = mobEquipmentPackets[0]
//                 // assert.strictEqual(firstPacket.window_id, 'inventory', 'First packet should be for inventory window')
//                 // assert.strictEqual(firstPacket.item.network_id, 261, 'First packet should have iron sword (network_id 261)')
//                 // assert.strictEqual(firstPacket.slot, 5, 'First packet should be for prismarine slot 14 (hotbar slot 5)')
//                 // assert.strictEqual(firstPacket.selected_slot, 5, 'First packet selected_slot should be 14')

//                 // Second packet: offhand slot with shield (network_id 387)
//                 const secondPacket = mobEquipmentPackets[1]
//                 // assert.strictEqual(secondPacket.window_id, 'offhand', 'Second packet should be for offhand window')
//                 // assert.strictEqual(secondPacket.item.network_id, 387, 'Second packet should have shield (network_id 387)')
//                 // assert.strictEqual(secondPacket.slot, 1, 'Second packet should be for offhand slot 1')
//                 // assert.strictEqual(secondPacket.selected_slot, 0, 'Second packet selected_slot should be 0')

//                 expect(firstPacket).toEqual({
//                   "runtime_entity_id": 182n,
//                   "item": {
//                     "network_id": 261,
//                     "count": 1,
//                     "metadata": 0,
//                     "has_stack_id": 0,
//                     "block_runtime_id": 0,
//                     "extra": {
//                       "has_nbt": true,
//                       "nbt": {
//                         "version": 1,
//                         "nbt": {
//                           "type": "compound",
//                           "name": "",
//                           "value": {
//                             "Damage": {
//                               "type": "int",
//                               "value": 0
//                             }
//                           }
//                         }
//                       },
//                       "can_place_on": [],
//                       "can_destroy": []
//                     }
//                   },
//                   "slot": 5,
//                   "selected_slot": 5,
//                   "window_id": "inventory"
//                 })

//                 expect(secondPacket).toEqual({
//                   "runtime_entity_id": 182n,
//                   "item": {
//                     "network_id": 387,
//                     "count": 1,
//                     "metadata": 0,
//                     "has_stack_id": 0,
//                     "block_runtime_id": 0,
//                     "extra": {
//                       "has_nbt": true,
//                       "nbt": {
//                         "version": 1,
//                         "nbt": {
//                           "type": "compound",
//                           "name": "",
//                           "value": {
//                             "Damage": {
//                               "type": "int",
//                               "value": 0
//                             }
//                           }
//                         }
//                       },
//                       "can_place_on": [],
//                       "can_destroy": [],
//                       "blocking_tick": 0n
//                     }
//                   },
//                   "slot": 1,
//                   "selected_slot": 0,
//                   "window_id": "offhand"
//                 })

//                 done()
//               } catch (err) {
//                 done(err)
//               }
//             })
//           }
//         }
//         return originalWrite(packetName, data)
//       }

//       const bot = mineflayer.createBot({
//         host: '127.0.0.1',
//         port: 19132,
//         username: 'TestBot',
//         version: 'bedrock_1.21.130',
//         client: replayClient
//       })

//       bot.once('error', (err) => {
//         done(err)
//       })

//       // If no mob_equipment packets are sent within timeout, fail the test
//       setTimeout(() => {
//         if (mobEquipmentPackets.length < expectedPackets) {
//           done(new Error(`Expected ${expectedPackets} mob_equipment packets but only received ${mobEquipmentPackets.length}`))
//         }
//       }, 5000)
//     })
//   })
// })
