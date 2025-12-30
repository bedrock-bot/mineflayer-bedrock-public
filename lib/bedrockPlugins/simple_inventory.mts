import type { Bot, EquipmentDestination } from "../../index.js";
import type { Item } from "prismarine-item";

export default function inject(bot: Bot) {
  async function equip(
    item: Item | number,
    destination: EquipmentDestination | null
  ): Promise<void> {
    //
  }
  async function unequip(
    destination: EquipmentDestination | null
  ): Promise<void> {
    //
  }
  async function toss(
    itemType: number,
    metadata: number | null,
    count: number | null
  ): Promise<void> {
    //
  }
  async function tossStack(item: Item): Promise<void> {
    //
  }
  function setQuickBarSlot(slot: number): void {
    //
  }
  function getDestSlot(destination: string): number {
    throw new Error("getDestSlot is not implemented");
  }

  async function leftMouse(slot: number): Promise<void> {
    //
  }

  async function rightMouse(slot: number): Promise<void> {
    //
  }

  bot.equip = equip;
  bot.unequip = unequip;
  bot.toss = toss;
  bot.tossStack = tossStack;
  bot.setQuickBarSlot = setQuickBarSlot;
  bot.getEquipmentDestSlot = getDestSlot;
  bot.simpleClick = { leftMouse, rightMouse };
}
