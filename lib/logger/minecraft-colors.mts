/**
 * Minecraft color code to ANSI escape sequence mapping.
 * Converts Minecraft's § color codes to terminal colors.
 * Adapted from @serenityjs/logger
 */
const ansiColors: Record<string, string> = {
  '0': '\u001B[38;2;0;0;0m', // Black
  '1': '\u001B[38;2;0;0;170m', // Dark Blue
  '2': '\u001B[38;2;0;170;0m', // Dark Green
  '3': '\u001B[38;2;0;170;170m', // Dark Aqua
  '4': '\u001B[38;2;170;0;0m', // Dark Red
  '5': '\u001B[38;2;170;0;170m', // Dark Purple
  '6': '\u001B[38;2;255;170;0m', // Gold
  '7': '\u001B[38;2;170;170;170m', // Gray
  '8': '\u001B[38;2;85;85;85m', // Dark Gray
  '9': '\u001B[38;2;85;85;255m', // Blue
  a: '\u001B[38;2;85;255;85m', // Green
  b: '\u001B[38;2;85;255;255m', // Aqua
  c: '\u001B[38;2;255;85;85m', // Red
  d: '\u001B[38;2;255;85;255m', // Light Purple
  e: '\u001B[38;2;255;255;85m', // Yellow
  f: '\u001B[38;2;255;255;255m', // White
  g: '\u001B[38;2;221;214;5m', // Minecoin Gold
  h: '\u001B[38;2;227;212;209m', // Material Quartz
  i: '\u001B[38;2;206;202;202m', // Material Iron
  j: '\u001B[38;2;68;58;59m', // Material Netherite
  m: '\u001B[38;2;151;22;7m', // Material Redstone
  n: '\u001B[38;2;180;104;77m', // Material Copper
  p: '\u001B[38;2;222;177;45m', // Material Gold
  q: '\u001B[38;2;71;160;54m', // Material Emerald
  r: '\u001B[0m', // Reset
  s: '\u001B[38;2;44;186;168m', // Material Diamond
  t: '\u001B[38;2;33;73;123m', // Material Lapis
  u: '\u001B[38;2;154;92;198m', // Material Amethyst
};

const colorCodeRegex = /§[\da-fk-or-u]/g;

/**
 * Converts Minecraft color codes (§) to ANSI escape sequences.
 * @param text - Text containing Minecraft color codes
 * @returns Text with ANSI escape sequences
 */
export function formatMinecraftColorCode(text: string): string {
  return (
    text.replace(colorCodeRegex, (match) => {
      const code = match.charAt(1);
      return ansiColors[code] || '';
    }) + '\u001B[0m'
  );
}

/**
 * Strips Minecraft color codes from text.
 * @param text - Text containing Minecraft color codes
 * @returns Plain text without color codes
 */
export function stripMinecraftColorCodes(text: string): string {
  return text.replace(colorCodeRegex, '');
}
