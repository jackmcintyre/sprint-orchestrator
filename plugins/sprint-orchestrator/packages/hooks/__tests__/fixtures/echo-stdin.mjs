import { readStdinJson, writeJson } from "../../dist/lib/io.js";
const value = await readStdinJson();
writeJson(value);
