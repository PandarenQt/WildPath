import {FACILITY_SQUARES, mapProblems, mapSize, sharedGrid} from "../helpers/bastions.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/** A facility's color on the map, by its place in the list. */
const colorOf = index => `hsl(${(index * 67) % 360} 55% 45%)`;

/**
 * The Bastion Map (2026-10-22): its character's owner lays out its facilities on a grid of 5-foot squares, as large as
 * its level allows (helpers/bastions.mjs `mapSize`). Pick a facility, then click or drag over squares to give them to
 * it; right-click clears a square. A facility covers at most its space (Cramped 4, Roomy 16, Vast 36 squares), in any
 * shape. Saved on the character (`system.bastion.map.cells`). The GM can make a Scene of it: each facility's squares
 * coloured and named, walls around them, the doors left to place.
 * A shared Bastion (docs/architecture/shared-bastions.md) is one map of its members' squares, on the grid their pooled
 * ground makes: this user lays out the facilities of the members they own; the others' squares are read live from
 * their characters, drawn hatched, and left alone. A facility is keyed `${actorId}.${itemId}` across the whole map.
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

  /** One map window per Bastion: a shared one is the same window from any member's sheet. */
  static idOf(actor) {
    const shared = actor.system.bastion?.shared?.id;
    return shared ? `wildpath-bastion-map-shared-${shared}` : `wildpath-bastion-map-${actor.id}`;
  }

  /** The `updateActor` hook redrawing a shared map. */
  #hook = null;

  constructor(actor, options={}) {
    super({...options, id: WildPathBastionMap.idOf(actor)});
    this.actor = actor;
    this.groupId = actor.system.bastion?.shared?.id || "";
    // The members whose squares this window edits: the ones this user owns when it opens. One that joins later is read
    // live like the others, so a save never writes over squares this window never loaded.
    this.loaded = new Set(this.members.filter(member => member.isOwner).map(member => member.id));
    // Squares outside the grid (a character that lost levels, joined or left) are kept and shown as problems until
    // cleared. A second square on the same spot (two of this user's members) waits in `extra`, so a save keeps it.
    this.cells = new Map();
    this.extra = [];
    for ( const member of this.local ) for ( const cell of member.system.bastion?.map?.cells ?? [] ) {
      const key = `${cell.x},${cell.y}`;
      const id = `${member.id}.${cell.facilityId}`;
      if ( this.cells.has(key) ) this.extra.push({x: cell.x, y: cell.y, facilityId: id});
      else this.cells.set(key, id);
    }
    this.selected = null;
  }

  get title() {
    return this.groupId ? game.i18n.format("WILDPATH.BASTION.SharedTitle", {names: this.members.map(member => member.name).join(", ")})
      : game.i18n.format("WILDPATH.BASTION.MapTitle", {name: this.actor.name});
  }

  /** The characters whose Bastion this is: those carrying its shared id, or its character alone. */
  get members() {
    if ( !this.groupId ) return [this.actor];
    return game.actors.filter(actor => (actor.type === "character") && (actor.system.bastion?.shared?.id === this.groupId));
  }

  /** The members whose squares this window edits; the rest are read live. */
  get local() {
    return this.groupId ? this.members.filter(member => member.isOwner && this.loaded.has(member.id)) : [this.actor];
  }

  get editable() {
    return this.local.some(member => member.isOwner);
  }

  /** Every member's facilities, in order (its colour is its place), keyed `${actorId}.${itemId}`. */
  #facilities() {
    return this.members.flatMap(member => member.items.filter(item => item.type === "facility")
      .map(item => ({key: `${member.id}.${item.id}`, item, member})));
  }

  #facility(key="") {
    const [actorId, itemId] = key.split(".");
    return this.members.find(member => member.id === actorId)?.items.get(itemId);
  }

  #grid() {
    return this.groupId ? sharedGrid(this.members) : {size: mapSize(this.actor.system.details?.level), capacity: undefined};
  }

  #problems(cells) {
    const {size, capacity} = this.#grid();
    return mapProblems(cells, {size, most: capacity,
      facilities: Object.fromEntries(this.#facilities().map(({key, item}) => [key, item.system.size]))});
  }

  async _prepareContext() {
    const {size} = this.#grid();
    const facilities = this.#facilities();
    const index = new Map(facilities.map((facility, i) => [facility.key, i]));
    const label = key => {
      const facility = facilities[index.get(key)];
      if ( !facility ) return "";
      return this.groupId ? game.i18n.format("WILDPATH.BASTION.MemberFacility", {facility: facility.item.name, member: facility.member.name})
        : facility.item.name;
    };
    const others = this.#otherCells();
    const cells = [...this.#cellList(), ...others];
    const counts = {};
    for ( const {facilityId} of cells ) counts[facilityId] = (counts[facilityId] ?? 0) + 1;
    const fixed = new Map(others.map(cell => [`${cell.x},${cell.y}`, cell.facilityId]));
    const local = this.local;
    return {
      size, editable: this.editable, isGM: game.user.isGM,
      problems: this.#problems(cells).map(problem => game.i18n.format(problem.key, {...problem.data, name: label(problem.data.id)})),
      groups: this.members.map(member => ({name: this.groupId ? member.name : "", facilities: facilities.filter(facility => facility.member === member)
        .map(({key, item}) => ({id: key, name: item.name, color: colorOf(index.get(key)), selected: key === this.selected,
          pickable: local.includes(member), used: counts[key] ?? 0, most: FACILITY_SQUARES[item.system.size] ?? 0,
          size: game.i18n.localize(`WILDPATH.BASTION.Sizes.${item.system.size || "cramped"}`)}))})),
      rows: Array.from({length: size}, (_, y) => Array.from({length: size}, (__, x) => {
        const mine = this.cells.get(`${x},${y}`);
        const id = mine ?? fixed.get(`${x},${y}`);
        return {x, y, readonly: !mine && !!id, color: id && index.has(id) ? colorOf(index.get(id)) : "", title: id ? label(id) : ""};
      }))
    };
  }

  /** This window's squares (its edits), of facilities that still exist. */
  #cellList() {
    return [...[...this.cells].map(([key, facilityId]) => {
      const [x, y] = key.split(",").map(Number);
      return {x, y, facilityId};
    }), ...this.extra].filter(cell => this.#facility(cell.facilityId));
  }

  /** The other members' squares, as their characters hold them now. */
  #otherCells() {
    if ( !this.groupId ) return [];
    const local = this.local;
    return this.members.filter(member => !local.includes(member)).flatMap(member => (member.system.bastion?.map?.cells ?? [])
      .filter(cell => member.items.has(cell.facilityId)).map(cell => ({x: cell.x, y: cell.y, facilityId: `${member.id}.${cell.facilityId}`})));
  }

  /** A square given to the picked facility (or taken from it), as long as that facility has squares left. */
  #paint(x, y, clear=false) {
    const key = `${x},${y}`;
    if ( clear ) return this.cells.delete(key);
    if ( !this.selected ) return false;
    // Another member's square is theirs to change.
    if ( this.#otherCells().some(cell => (cell.x === x) && (cell.y === y)) ) return false;
    const most = FACILITY_SQUARES[this.#facility(this.selected)?.system.size] ?? 0;
    const used = [...this.cells.values()].filter(id => id === this.selected).length;
    if ( (this.cells.get(key) !== this.selected) && (used >= most) ) return false;
    this.cells.set(key, this.selected);
    return true;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // The other members' squares are read live: a change to a member's Bastion (or one joining or leaving) redraws it.
    if ( this.groupId ) this.#hook = Hooks.on("updateActor", (actor, changes) => {
      if ( (actor.type !== "character") || !foundry.utils.hasProperty(changes, "system.bastion") ) return;
      if ( (actor.system.bastion?.shared?.id === this.groupId) || foundry.utils.hasProperty(changes, "system.bastion.shared.id") ) void this.render();
    });
  }

  _onClose(options) {
    super._onClose(options);
    if ( this.#hook !== null ) Hooks.off("updateActor", this.#hook);
    this.#hook = null;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    if ( !this.editable ) return;
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
    const index = this.#facilities().findIndex(facility => facility.key === id);
    cell.style.backgroundColor = index >= 0 ? colorOf(index) : "";
  }

  static #onPick(event, target) {
    const key = target.dataset.facilityId;
    if ( this.local.some(member => key.startsWith(`${member.id}.`)) ) this.selected = key;
    void this.render();
  }

  static #onClear() {
    if ( this.selected ) {
      for ( const [key, id] of [...this.cells] ) if ( id === this.selected ) this.cells.delete(key);
      this.extra = this.extra.filter(cell => cell.facilityId !== this.selected);
    }
    void this.render();
  }

  /** Checks the whole map (the other members' squares as they are now), then writes each of this user's members its own. */
  static async #onSave() {
    const cells = this.#cellList();
    if ( this.#problems([...cells, ...this.#otherCells()]).length ) return ui.notifications.warn(game.i18n.localize("WILDPATH.BASTION.MapInvalid"));
    for ( const member of this.local ) {
      const prefix = `${member.id}.`;
      await member.update({"system.bastion.map.cells": cells.filter(cell => cell.facilityId.startsWith(prefix))
        .map(({x, y, facilityId}) => ({x, y, facilityId: facilityId.slice(prefix.length)}))});
    }
    ui.notifications.info(game.i18n.localize("WILDPATH.BASTION.MapSaved"));
  }

  /** A Scene of the map: each facility's squares coloured and named, walls where a square meets another facility or nothing. */
  static async #onMakeScene() {
    if ( !game.user.isGM ) return;
    const {size} = this.#grid();
    const grid = 100;
    const cells = [...this.#cellList(), ...this.#otherCells()];
    const owner = new Map(cells.map(cell => [`${cell.x},${cell.y}`, cell.facilityId]));
    const facilities = this.#facilities();
    const colors = new Map(facilities.map(({key}, i) => [key, Color.fromHSL([((i * 67) % 360) / 360, 0.55, 0.45])]));
    const name = this.groupId ? game.i18n.format("WILDPATH.BASTION.SharedTitle", {names: this.members.map(member => member.name).join(", ")})
      : game.i18n.format("WILDPATH.BASTION.SceneName", {name: this.actor.name});
    const scene = await Scene.create({name, width: size * grid,
      height: size * grid, padding: 0, grid: {size: grid, distance: 5, units: "ft"}, backgroundColor: "#2b2b2b"});
    const drawings = cells.map(cell => ({shape: {type: "r", width: grid, height: grid}, x: cell.x * grid, y: cell.y * grid,
      fillType: 1, fillColor: colors.get(cell.facilityId)?.css ?? "#666666", fillAlpha: 0.6, strokeWidth: 0}));
    for ( const {key, item, member} of facilities ) {
      const first = cells.find(cell => cell.facilityId === key);
      const text = this.groupId ? game.i18n.format("WILDPATH.BASTION.MemberFacility", {facility: item.name, member: member.name}) : item.name;
      if ( first ) drawings.push({shape: {type: "r", width: grid * 2, height: grid / 2}, x: first.x * grid + 4, y: first.y * grid + 4,
        text, fontSize: 24, textColor: "#ffffff", strokeWidth: 0, fillType: 0});
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
