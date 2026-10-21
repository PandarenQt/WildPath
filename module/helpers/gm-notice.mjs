/**
 * A step that ran on the GM's client and couldn't do what was asked (a summon with no creature, a push with no Token, an
 * automatic step that threw): the GM is told in words, and the details go to the console. Players are never told.
 * `key` is a lang key, `data` its format data; `details` is logged with it.
 * @param {string} key
 * @param {Record<string, unknown>} [data]
 * @param {unknown} [details]
 * @param {{game?: any, ui?: any, logger?: {warn(...args: unknown[]): void}}} [options]
 * @returns {string}
 */
export function gmNotice(key, data={}, details=undefined, {game=globalThis.game, ui=globalThis.ui, logger=globalThis.console}={}) {
  const text = game?.i18n?.format?.(key, data) ?? key;
  logger?.warn?.(`Wild Path | ${text}`, ...(details === undefined ? [] : [details]));
  if ( game?.user?.isGM ) ui?.notifications?.warn?.(text);
  return text;
}
