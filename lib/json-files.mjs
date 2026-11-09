import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));
export const saveJson = async (filename, data) => {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(data, null, 2) + "\n", "utf8");
};
