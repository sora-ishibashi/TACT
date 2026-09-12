// =========================
// TACT Bot — /api/tact/bot/slack Route Regression (S1a)
// =========================
//
// This route test supplies its own non-production signing secret. It exercises
// the real route and real HMAC verifier while leaving the caller's environment
// exactly as it found it.

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as slackWebhookRoute } from "../../../app/api/tact/bot/slack/route";
import { check, summarize, type CheckResult } from "../lib/check";

const TEST_SIGNING_SECRET = "test-slack-signing-secret";

function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`, "utf8")
    .digest("hex")}`;
}

function makeRequest(
  body: unknown,
  options: {
    timestamp?: string;
    signature?: string | null;
    signingSecret?: string;
  } = {}
): NextRequest {
  const rawBody = JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = options.signature === undefined
    ? computeSignature(options.signingSecret ?? TEST_SIGNING_SECRET, timestamp, rawBody)
    : options.signature;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
  };
  if (signature !== null) headers["x-slack-signature"] = signature;

  return new NextRequest("http://localhost/api/tact/bot/slack", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

function restoreSigningSecret(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.SLACK_SIGNING_SECRET;
  } else {
    process.env.SLACK_SIGNING_SECRET = previous;
  }
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];
  const previousSigningSecret = process.env.SLACK_SIGNING_SECRET;
  let environmentRestored = false;

  try {
    process.env.SLACK_SIGNING_SECRET = TEST_SIGNING_SECRET;

    {
      const response = await slackWebhookRoute(
        makeRequest({ type: "url_verification", challenge: "test-challenge" })
      );
      const body = await response.json();
      results.push(check(
        "[Route] a request signed with the isolated fixture reaches the real verifier and succeeds",
        response.status === 200 && body.challenge === "test-challenge"
      ));
    }

    {
      const response = await slackWebhookRoute(
        makeRequest(
          { type: "url_verification", challenge: "test-challenge" },
          { signature: "v0=0000000000000000000000000000000000000000000000000000000000000000" }
        )
      );
      const body = await response.json();
      results.push(check(
        "[Route] an incorrect signature is rejected by the real verifier",
        response.status === 401 && body.error === "invalid_signature"
      ));
    }

    {
      const staleTimestamp = String(Math.floor(Date.now() / 1000) - (5 * 60 + 1));
      const response = await slackWebhookRoute(
        makeRequest(
          { type: "url_verification", challenge: "test-challenge" },
          { timestamp: staleTimestamp }
        )
      );
      const body = await response.json();
      results.push(check(
        "[Route] a correctly signed but stale request remains rejected",
        response.status === 401 && body.error === "invalid_signature"
      ));
    }

    {
      const response = await slackWebhookRoute(
        makeRequest({ type: "url_verification", challenge: "test-challenge" }, { signature: null })
      );
      const body = await response.json();
      results.push(check(
        "[Route] a request with no signature remains rejected",
        response.status === 401 && body.error === "invalid_signature"
      ));
    }

    {
      const response = await slackWebhookRoute(makeRequest({}));
      results.push(check(
        "[Route] a validly signed non-event payload does not throw from the route boundary",
        response.status === 200
      ));
    }

    {
      delete process.env.SLACK_SIGNING_SECRET;
      const response = await slackWebhookRoute(
        makeRequest(
          { type: "url_verification", challenge: "test-challenge" },
          { signingSecret: TEST_SIGNING_SECRET }
        )
      );
      const body = await response.json();
      results.push(check(
        "[Route] production-style missing configuration remains fail-closed",
        response.status === 401 && body.error === "not_configured"
      ));
      process.env.SLACK_SIGNING_SECRET = TEST_SIGNING_SECRET;
    }
  } finally {
    restoreSigningSecret(previousSigningSecret);
    environmentRestored = process.env.SLACK_SIGNING_SECRET === previousSigningSecret;
  }

  results.push(check(
    "[Route] the suite restores the exact prior SLACK_SIGNING_SECRET value",
    environmentRestored
  ));

  return summarize("bot/slackWebhookRoute", results);
}
