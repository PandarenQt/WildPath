/**
 * The Item document subclass for the WildPath system.
 */
export default class WildPathItem extends Item {

  /**
   * Convenience shortcut: if this is an "action" Item owned by an Actor, spend its resource
   * cost via the owning Actor.
   * @returns {Promise<boolean>}
   */
  async use() {
    if ( (this.type !== "action") || !this.actor ) return false;
    return this.actor.useAction(this);
  }
}
