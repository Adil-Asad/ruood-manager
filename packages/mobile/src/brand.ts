/**
 * The product's name, in one place, spelled one way.
 *
 * Its own module rather than a line in `config.ts`, and that is not fussiness:
 * `config.ts` imports `expo-constants`, which is a native module. Anything that
 * imports it therefore cannot be loaded by the node-only jest config — and
 * `language.ts`, which is the module that decides every word an administrator
 * reads, is exactly the thing most worth testing.
 *
 * So the one value they share lives below both of them and depends on nothing.
 * The same split as `platform.ts` in RUOOD Lab's announcements module, made for
 * the same reason and after the same mistake.
 */

export const PRODUCT_NAME = 'RUOOD Manager';
