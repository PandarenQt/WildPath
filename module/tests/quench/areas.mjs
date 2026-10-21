import {useQuenchFixtures} from "./fixtures.mjs";
import {foundryAreaFootprint, foundryAreaTargetTokens} from "../../adapters/foundry-v14-area-placement.mjs";
import {createFoundryV14TacticalGridAdapter} from "../../adapters/foundry-v14-tactical-grid-adapter.mjs";

const AREAS = {
  burst: {area:{shape:"radial",size:{value:5,unit:"ft"}},range:{type:"ranged",normal:{value:60,unit:"ft"}}},
  cone: {area:{shape:"cone",size:{value:15,unit:"ft"}}},
  line: {area:{shape:"line",size:{value:30,unit:"ft"}}}
};

/**
 * Areas on Foundry's own square and hex grids: the corner a click picks, and who each shape covers. The same
 * layout as the Level-5 run (caster at offset 4,2; goblins at 4,5 and 5,6; a bystander at 4,9), so the
 * geometry that once mapped corners wrongly on real grids is pinned here.
 */
export function registerAreaTests(quench) {
  quench.registerBatch("wildpath.areas", context => {
    const {describe,it,assert,beforeEach,afterEach} = context;
    describe("Area placement on real Foundry V14 grids (GM)", function () {
      this.timeout(30000);
      const fixtures = useQuenchFixtures({beforeEach,afterEach});

      async function layout(type) {
        const scene = await fixtures.createScene({name:`areas ${type}`,grid:{type:CONST.GRID_TYPES[type],size:100,distance:5}});
        scene.initializeEdges();
        const tokens = {};
        for (const [name,i,j] of [["caster",4,2],["goblin A",4,5],["goblin B",5,6],["bystander",4,9]]) {
          const base = await fixtures.createActor({name,system:{resources:{health:{base:30,value:30}}}});
          tokens[name] = await fixtures.createToken(scene,base,{name,...scene.grid.getTopLeftPoint({i,j}),
            elevation:0,level:scene.initialLevel.id});
        }
        const names = new Map(Object.entries(tokens).map(([name,token]) => [token.id,name]));
        const corner = index => scene.grid.getVertices({i:4,j:2})[index];
        const hit = (shape,points) => {
          const placed = foundryAreaFootprint({definition:AREAS[shape],sourceToken:tokens.caster,points});
          assert.isTrue(placed.ok,JSON.stringify(placed));
          return foundryAreaTargetTokens({sourceToken:tokens.caster,footprint:placed.footprint}).map(token => names.get(token.id)).sort();
        };
        return {scene,tokens,corner,hit,adapter:createFoundryV14TacticalGridAdapter({scene})};
      }

      it("square: a click picks its own corner, and burst, cone and line cover exactly their squares", async () => {
        const {scene,corner,hit,adapter} = await layout("SQUARE");
        // Foundry's square offsets are {i: row, j: column}; the bottom-right corner is vertex (5,3) at (300,500).
        assert.deepEqual(corner(2),{x:300,y:500});
        assert.equal(adapter.pointToVertex({x:296,y:507}).vertex.id,"square-vertex:5,3");
        const east = {x:corner(2).x + 400,y:corner(2).y};
        assert.deepEqual(hit("burst",[scene.grid.getCenterPoint({i:5,j:5})]),["goblin A","goblin B"]);
        assert.deepEqual(hit("cone",[corner(2),east]),["goblin A"]);
        assert.deepEqual(hit("line",[corner(2),east]),["goblin A"]);
      });

      it("a line aimed at a flying creature tilts up to it; aimed where none stands it stays level", async () => {
        const {tokens,corner} = await layout("SQUARE");
        await tokens["goblin A"].update({elevation:30});
        const flying = game.scenes.get(tokens.caster.parent.id).tokens.get(tokens["goblin A"].id);
        const covered = second => {
          const placed = foundryAreaFootprint({definition:AREAS.line,sourceToken:tokens.caster,points:[corner(2),second]});
          assert.isTrue(placed.ok,JSON.stringify(placed));
          return foundryAreaTargetTokens({sourceToken:tokens.caster,footprint:placed.footprint,definition:AREAS.line})
            .map(token => token.name);
        };
        assert.include(covered({x:flying.x + 50,y:flying.y + 50}).join(),"goblin A","aimed at it, 30 feet up, it reaches it");
        assert.notInclude(covered({x:corner(2).x + 400,y:corner(2).y}).join(),"goblin A","aimed level, it passes beneath");
      });

      it("hex: a click picks the corner its hexes share, and burst, cone and line cover exactly their hexes", async () => {
        const {corner,hit,adapter} = await layout("HEXODDR");
        // The caster's upper-right corner is shared with its east and north-east neighbours.
        const upperRight = corner(1);
        assert.equal(adapter.pointToVertex(upperRight).vertex.id,"hex-vertex:hex:0,4|hex:1,3|hex:1,4");
        const ring = adapter.fieldToCenterPoint({q:4,r:4}).point;
        assert.deepEqual(hit("burst",[ring]),["goblin A","goblin B"]);
        assert.deepEqual(hit("cone",[upperRight,{x:upperRight.x + 600,y:upperRight.y}]),["goblin A"]);
        assert.deepEqual(hit("line",[corner(2),{x:corner(2).x + 600,y:corner(2).y}]),["goblin A"]);
      });

      it("refuses a cone that does not start on the caster's edge, and a burst out of range", async () => {
        const {scene,tokens,corner} = await layout("SQUARE");
        const caster = tokens.caster;
        const offEdge = foundryAreaFootprint({definition:AREAS.cone,sourceToken:caster,
          points:[{x:corner(2).x + 300,y:corner(2).y - 200},{x:900,y:500}]});
        assert.deepEqual([offEdge.ok,offEdge.code],[false,"NotOnEdge"]);
        const far = foundryAreaFootprint({definition:{...AREAS.burst,range:{type:"ranged",normal:{value:5,unit:"ft"}}},
          sourceToken:caster,points:[scene.grid.getCenterPoint({i:5,j:5})]});
        assert.deepEqual([far.ok,far.code],[false,"OutOfRange"]);
      });
    });
  }, {displayName:"WILDPATH: Areas",preSelected:false});
}
