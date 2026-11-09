import { readFile, writeFile } from "node:fs/promises";
import { CodexRuntime } from "../lib/codex.mjs";
import { analyzeScan } from "../lib/integrations.mjs";
const scan = JSON.parse(await readFile("examples/figma-scan.json", "utf8"));
scan.images = [
  {
    nodeId: "example:1",
    dataUrl:
      "data:image/png;base64," +
      (await readFile("examples/figma-scan.png")).toString("base64"),
  },
];
await writeFile(
  "output/codex-input-synthetic.json",
  JSON.stringify(scan, null, 2),
);
const runtime = new CodexRuntime();
try {
  const analysis = await analyzeScan(scan, { runtime });
  await writeFile(
    "output/codex-live-proof.json",
    JSON.stringify(
      { input: "synthetic planning screen; not a real Figma export", analysis },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(analysis, null, 2));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  runtime.close();
}
