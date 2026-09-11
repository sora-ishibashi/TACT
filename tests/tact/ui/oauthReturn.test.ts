import {
  buildConnectionConfirmEndpoint,
  readOAuthReturnConnectionId,
  removeOAuthReturnConnectionId,
} from "../../../components/tact/connections/oauthReturn";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  results.push(
    check(
      "[OAuth return] parses the canonical connectionId from the return query",
      readOAuthReturnConnectionId("?section=settings&connectionId=conn-123&source=oauth") === "conn-123"
    )
  );

  results.push(
    check(
      "[OAuth return] has no confirmation target when connectionId is absent",
      readOAuthReturnConnectionId("?section=settings") === null
    )
  );

  results.push(
    check(
      "[OAuth return] empty or whitespace connectionId fails safely",
      readOAuthReturnConnectionId("?section=settings&connectionId=%20%20") === null
    )
  );

  const cleanedUrl = new URL(
    removeOAuthReturnConnectionId(
      "https://tact.example.com/?section=settings&connectionId=conn-123&source=oauth#connections"
    )
  );

  results.push(
    check(
      "[OAuth return] removes only connectionId while preserving section=settings, unrelated params, and hash",
      cleanedUrl.searchParams.get("connectionId") === null &&
        cleanedUrl.searchParams.get("section") === "settings" &&
        cleanedUrl.searchParams.get("source") === "oauth" &&
        cleanedUrl.hash === "#connections"
    )
  );

  results.push(
    check(
      "[OAuth return] builds the encoded canonical confirm endpoint",
      buildConnectionConfirmEndpoint("conn/id?") === "/api/tact/connections/conn%2Fid%3F/confirm"
    )
  );

  return summarize("ui/oauthReturn", results);
}
