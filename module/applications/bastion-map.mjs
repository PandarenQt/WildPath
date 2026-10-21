import {FACILITY_SQUARES, mapProblems, mapSize} from "../helpers/bastions.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/** A facility's color on the map, by its place in the list. */
const colorOf = index => `hsl(${(index * 67) % 360} 55% 45%)`;

/**
 * The Bastion Map (2026-10-22): its character's owner lays out its facilities on a grid of 5-foot squares, as large as
 * its level allows (helpers/bastions.mjs `mapSize`). Pick a facility, then click or drag over squares to give them to
 * it; right-click clears a square. A facility covers at most its space (Cramped 4, Roomy 16, Vast 36 squares), in any
 * shape. Saved on the character (`system.bastion.map.cells`). The GM can make a Scene of it: each facility's squares
 * coloured and named, walls around them, the doors left to place.
 */
export class WildPathBastionMap extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["wildpath", "bastion-map", "themed", "theme-light"],
    window: {title: "WILDPATH.BASTION.MapTitle", resizable: true},
    position: {width: 820, height: 700},
    actions: {pick: WildPathBastionMap.#onPick, save: WildPathBastionMap.#onSave, makeScene: WildPathBastionMap.#onMakeScene,
      clear: WildPathBastionMap.#onClear}
  };

  static PARTS = {body: {template: "systems/wildpath/templates/apps/bastion-map.hbs"}};

  constructor(actor, options={}) {
    super({...options, id: `wildpath-bastion-map-${actor.id}`});
    this.actor = actor;
    this.cells = new Map((actor.system.bastion?.map?.cells ?? []).map(cell => [`${cell.x},${cell.y}`, cell.facilityId]));
    this.selected = null;
  }

  get title() {
    return game.i18n.format("WILDPATH.BASTION.MapTitle", {name: this.actor.name});
  }

  get facilities() {
    return this.actor.items.filter(item => item.type === "facility");
  }

  async _prepareContext() {
    const size = mapSize(this.actor.system.details?.level);
    const facilities = this.facilities;
    const index = new Map(facilities.map((facility, i) => [facility.id, i]));
    const counts = {};
    for ( const id of this.cells.values() ) counts[id] = (counts[id] ?? 0) + 1;
    const problems = mapProblems(this.#cellList(), {size, facilities: Object.fromEntries(facilities.map(facility => [facility.id, facility.system.size]))});
    return {
      size, editable: this.actor.isOwner, isGM: game.user.isGM,
      problems: problems.map(problem => game.i18n.format(problem.key, {...problem.data,
        name: this.actor.items.get(problem.data.id)?.name ?? ""})),
      facilities: facilities.map((facility, i) => ({id: facility.id, name: facility.name, color: colorOf(i), selected: facility.id === this.selected,
        used: counts[facility.id] ?? 0, most: FACILITY_SQUARES[facility.system.size] ?? 0,
        size: game.i18n.localize(`WILDPATH.BASTION.Sizes.${facility.system.size || "cramped"}`)})),
      rows: Array.from({length: size}, (_, y) => Array.from({length: size}, (__, x) => {
        const id = this.cells.get(`${x},${y}`);
        return {x, y, color: id && index.has(id) ? colorOf(index.get(id)) : "", title: id ? (this.actor.items.get(id)?.name ?? "") : ""};
      }))
    };
  }

  #cellList() {
    return [...this.cells].filter(([, id]) => this.actor.items.has(id)).map(([key, facilityId]) => {
      const [x, y] = key.split(",").map(Number);
      return {x, y, facilityId};
    });
  }

  /** A square given to the picked facility (or taken from it), as long as that facility has squares left. */
  #paint(x, y, clear=false) {
    const key = `${x},${y}`;
    if ( clear ) return this.cells.delete(key);
    if ( !this.selected ) return false;
    const most = FACILITY_SQUARES[this.actor.items.get(this.selected)?.system.size] ?? 0;
    const used = [...this.cells.values()].filter(id => id === this.selected).length;
    if ( (this.cells.get(key) !== this.selected) && (used >= most) ) return false;
    this.cells.set(key, this.selected);
    return true;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if ( !this.actor.isOwner ) return;
    let painting = null;
    const grid = this.element.querySelector(".bastion-grid");
    const at = event => event.target.closest("[data-x]");
    grid?.addEventListener("contextmenu", event => event.preventDefault());
    grid?.addEventListener("pointerdown", event => {
      const cell = at(event);
      if ( !cell ) return;
      painting = event.button === 2 ? "clear" : "paint";
      if ( this.#paint(Number(cell.dataset.x), Number(cell.dataset.y), painting === "clear") ) this.#show(cell);
      globalThis.addEventListener("pointerup", () => {
        painting = null;
        void this.render();
      }, {once: true});
    });
    grid?.addEventListener("pointerover", event => {
      const cell = at(event);
      if ( painting && cell && this.#paint(Number(cell.dataset.x), Number(cell.dataset.y), painting === "clear") ) this.#show(cell);
    });
  }

  /** A painted square, at once (the counts follow on the next render). */
  #show(cell) {
    const id = this.cells.get(`${cell.dataset.x},${cell.dataset.y}`);
    const index = this.facilities.findIndex(facility => facility.id === id);
    cell.style.background = index >= 0 ? colorOf(index) : "";
  }

  static #onPick(event, target) {
    this.selected = target.dataset.facilityId;
    void this.render();
  }

  static #onClear() {
    if ( this.selected ) for ( const [key, id] of [...this.cells] ) if ( id === this.selected ) this.cells.delete(key);
    void this.render();
  }

  static async #onSave() {
    const size = mapSize(this.actor.system.details?.level);
    const cells = this.#cellList();
    const problems = mapProblems(cells, {size, facilities: Object.fromEntries(this.facilities.map(facility => [facility.id, facility.system.size]))});
    if ( problems.length ) return ui.notifications.warn(game.i18n.localize("WILDPATH.BASTION.MapInvalid"));
    await this.actor.update({"system.bastion.map.cells": cells});
    ui.notifications.info(game.i18n.localize("WILDPATH.BASTION.MapSaved"));
  }

  /** A Scene of the map: each facility's squares coloured and named, walls where a square meets another facility or nothing. */
  static async #onMakeScene() {
    if ( !game.user.isGM ) return;
    const size = mapSize(this.actor.system.details?.level);
    const grid = 100;
    const cells = this.#cellList();
    const owner = new Map(cells.map(cell => [`${cell.x},${cell.y}`, cell.facilityId]));
    const facilities = this.facilities;
    const colors = new Map(facilities.map((facility, i) => [facility.id, Color.fromHSL([((i * 67) % 360) / 360, 0.55, 0.45])]));
    const scene = await Scene.create({name: game.i18n.format("WILDPATH.BASTION.SceneName", {name: this.actor.name}), width: size * grid,
      height: size * grid, padding: 0, grid: {size: grid, distance: 5, units: "ft"}, backgroundColor: "#2b2b2b"});
    const drawings = cells.map(cell => ({shape: {type: "r", width: grid, height: grid}, x: cell.x * grid, y: cell.y * grid,
      fillType: 1, fillColor: colors.get(cell.facilityId)?.css ?? "#666666", fillAlpha: 0.6, strokeWidth: 0}));
    for ( const facility of facilities ) {
      const first = cells.find(cell => cell.facilityId === facility.id);
      if ( first ) drawings.push({shape: {type: "r", width: grid * 2, height: grid / 2}, x: first.x * grid + 4, y: first.y * grid + 4,
        text: facility.name, fontSize: 24, textColor: "#ffffff", strokeWidth: 0, fillType: 0});
    }
    const walls = [];
    for ( const {x, y, facilityId} of cells ) {
      for ( const [dx, dy, edge] of [[0, -1, [x, y, x + 1, y]], [0, 1, [x, y + 1, x + 1, y + 1]], [-1, 0, [x, y, x, y + 1]], [1, 0, [x + 1, y, x + 1, y + 1]]] ) {
        const neighbour = owner.get(`${x + dx},${y + dy}`);
        // One wall per shared edge: drawn from the square on its left or top when both sides hold a facility.
        if ( neighbour === facilityId ) continue;
        if ( neighbour && ((dx < 0) || (dy < 0)) ) continue;
        walls.push({c: edge.map(value => value * grid)});
      }
    }
    if ( drawings.length ) await scene.createEmbeddedDocuments("Drawing", drawings);
    if ( walls.length ) await scene.createEmbeddedDocuments("Wall", walls);
    ui.notifications.info(game.i18n.format("WILDPATH.BASTION.SceneMade", {name: scene.name}));
  }
}
