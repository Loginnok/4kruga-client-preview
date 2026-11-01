import {cp,mkdir} from "node:fs/promises";
await mkdir("dist/public",{recursive:true});
await cp("public","dist/public",{recursive:true});
console.log("Production server and existing C assets built.");
