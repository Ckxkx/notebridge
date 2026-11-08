import esbuild from "esbuild";
import { readFile } from "node:fs/promises";
const notices = (await readFile("THIRD_PARTY_NOTICES.md", "utf8")).replaceAll("*/", "* /");
await esbuild.build({entryPoints:["src/main.ts"],bundle:true,external:["obsidian","electron"],format:"cjs",platform:"browser",target:"es2020",outfile:"main.js",sourcemap:false,banner:{js:`/* NoteBridge third-party notices\n${notices}\n*/`}});
