import { tavilySearch } from "./providers/tavily";
import { evidenceParser } from "./parser/evidenceParser";

export async function search(
  query: string
) {

  const results =
    await tavilySearch(query);

  return evidenceParser(results);

}