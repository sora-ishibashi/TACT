import "dotenv/config";
import { runTACT } from "./core";

async function main() {
  const result = await runTACT();

  console.log(result);
}

main();