import {readdirSync} from "node:fs";
import {compilePack} from "@foundryvtt/foundryvtt-cli";

/**
 * Compile every packs/_source/<name> folder into the LevelDB pack Foundry reads at packs/<name>. Only the JSON
 * sources are versioned. Close the world first: a running world holds a lock on every pack it loaded.
 */
for ( const name of readdirSync("packs/_source") ) {
  await compilePack(`packs/_source/${name}`, `packs/${name}`, {log: true});
}
