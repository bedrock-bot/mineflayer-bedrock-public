/**
 * Bedrock Implementation Core
 *
 * This module provides reusable utilities for Bedrock-specific implementations:
 * - Action builders for item_stack_request protocol
 * - Slot mapping between Bedrock and prismarine-windows
 * - Container transfer operations
 *
 * These utilities are used by the bedrockPlugins but can also be used
 * by external plugins that need to interact with Bedrock inventory.
 */

// Item Stack Actions - Core action building utilities
export {
  // Stack ID helpers
  getStackId,
  setStackId,

  // Container ID constants
  ContainerIds,
  type ContainerId,

  // Slot location types and helpers
  type SlotLocation,
  cursor,
  slot,
  containerSlot,
  inventorySlot,
  fromPlayerSlot,
  fromItem,

  // Action builder
  ActionBuilder,
  actions,

  // Request ID management
  getNextItemStackRequestId,
  getNextLegacyRequestId,
  resetRequestIds,

  // Request execution
  type ItemStackResult,
  executeRequest,
  sendRequest,
  waitForResponse,
  captureCursorStackId,

  // Convenience builders
  buildTakeRequest,
  buildPlaceRequest,
  buildSwapRequest,
  buildDropRequest,
} from './item-stack-actions.mts';

// Slot Mapping - Container ID and slot index mapping
export {
  SlotRanges,
  getSlotIndex,
  getWindow,
  type ContainerLocation,
  getContainerForCursorOp,
  getContainerFromSlot,
  slotToLocation,
  isHotbarSlot,
  isInventorySlot,
  isArmorSlot,
  isOffhandSlot,
  getArmorType,
  getArmorSlot,
} from './slot-mapping.mts';

// Container Operations - Transfer utilities
export { type TransferConfig, transferItems, depositToContainer, withdrawFromContainer, twoStepTransfer } from './container.mts';

// Crafting Core - Recipe management and crafting
export {
  // Types
  type BedrockRecipe,
  type Recipe,

  // Slot constants
  CraftingSlots,

  // Recipe parsing
  parseRecipe,

  // Recipe utilities
  fitsIn2x2,
  getIngredients,
  resolveIngredientId,
  itemMatchesIngredient,
  countMatchingItems,
  findIngredientSlots,

  // Recipe conversion and lookup
  convertToRecipe,
  findRecipesByOutput,
  hasIngredientsFor,

  // Crafting execution
  craftWithAuto,

  // Item helpers
  findItemInAllSlots,
  countAllItems,
} from './crafting-core.mts';

// Workstations - Specialized container interfaces
export {
  // Furnace
  openFurnace,
  FurnaceSlots,
  type Furnace,

  // Anvil
  openAnvil,
  AnvilSlots,
  type Anvil,

  // Enchanting
  openEnchantmentTable,
  EnchantingSlots,
  type EnchantmentTable,

  // Smithing
  openSmithingTable,
  SmithingSlots,
  type SmithingTable,

  // Stonecutter
  openStonecutter,
  StonecutterSlots,
  type Stonecutter,

  // Grindstone
  openGrindstone,
  GrindstoneSlots,
  type Grindstone,

  // Loom
  openLoom,
  LoomSlots,
  type Loom,

  // Brewing Stand
  openBrewingStand,
  BrewingSlots,
  type BrewingStand,

  // Cartography Table
  openCartographyTable,
  CartographySlots,
  type CartographyTable,
} from './workstations/index.mts';

// Window Types - Bedrock slot mappings are now handled by prismarine-windows patch
// See patches/prismarine-windows+2.9.0.patch for the Bedrock window definitions
