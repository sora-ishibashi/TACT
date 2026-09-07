// =========================
// TACT Bot — Slack Signature Verification Regression (S1a)
// =========================
//
// 対象: core/tact-bot/adapters/slack/verifySlackSignature.tsの
// verifySlackRequest()。node:crypto以外の依存を持たない純粋関数
// (live Slack/DBアクセスなし)。

import { createHmac } from "node:crypto";
import { verifySlackRequest } from "../../../core/tact-bot/adapters/slack/verifySlackSignature";
import { check, summarize, type CheckResult } from "../lib/check";

const SIGNING_SECRET = "fake-signing-secret-for-test-only";

function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", secret).update(baseString, "utf8").digest("hex");
  return `v0=${digest}`;
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  const rawBody = JSON.stringify({ type: "event_callback", event_id: "Ev1", event: { type: "app_mention" } });

  // ---- Case A: valid signature -> accepted ----
  {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = String(nowSeconds);
    const signature = computeSignature(SIGNING_SECRET, timestamp, rawBody);

    const result = verifySlackRequest({ rawBody, timestamp, signature, signingSecret: SIGNING_SECRET });

    results.push(
      check(
        "[Case A] 正しいsignature/timestamp/secretの組み合わせはok:trueを返す",
        result.ok === true
      )
    );
  }

  // ---- Case B: invalid signature -> rejected ----
  {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = String(nowSeconds);

    const result = verifySlackRequest({
      rawBody,
      timestamp,
      signature: "v0=0000000000000000000000000000000000000000000000000000000000000000",
      signingSecret: SIGNING_SECRET,
    });

    results.push(
      check(
        "[Case B] 不正なsignatureはok:false・reason:signature_mismatchを返す",
        result.ok === false && result.reason === "signature_mismatch"
      )
    );
  }

  // ---- Case C: timestamp >5min stale -> rejected(replay protection) ----
  {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const signature = computeSignature(SIGNING_SECRET, staleTimestamp, rawBody);

    const result = verifySlackRequest({
      rawBody,
      timestamp: staleTimestamp,
      signature,
      signingSecret: SIGNING_SECRET,
    });

    results.push(
      check(
        "[Case C] timestampが5分以上過去の場合、正しいsignatureでもok:false・reason:stale_timestampを返す(replay protection)",
        result.ok === false && result.reason === "stale_timestamp"
      )
    );
  }

  // ---- Case C': 未来方向の5分超ズレも同様にstale扱い ----
  {
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 6 * 60);
    const signature = computeSignature(SIGNING_SECRET, futureTimestamp, rawBody);

    const result = verifySlackRequest({
      rawBody,
      timestamp: futureTimestamp,
      signature,
      signingSecret: SIGNING_SECRET,
    });

    results.push(
      check(
        "[Case C'] timestampが5分以上未来の場合もstale_timestampとして拒否する(絶対値でのズレ判定)",
        result.ok === false && result.reason === "stale_timestamp"
      )
    );
  }

  // ---- Case D: missing signature -> rejected ----
  {
    const timestamp = String(Math.floor(Date.now() / 1000));

    const result = verifySlackRequest({
      rawBody,
      timestamp,
      signature: null,
      signingSecret: SIGNING_SECRET,
    });

    results.push(
      check(
        "[Case D] signatureヘッダーが無い場合、ok:false・reason:missing_signatureを返す",
        result.ok === false && result.reason === "missing_signature"
      )
    );
  }

  // ---- Case E: missing timestamp -> rejected ----
  {
    const result = verifySlackRequest({
      rawBody,
      timestamp: null,
      signature: "v0=whatever",
      signingSecret: SIGNING_SECRET,
    });

    results.push(
      check(
        "[Case E] timestampヘッダーが無い場合、ok:false・reason:missing_timestampを返す",
        result.ok === false && result.reason === "missing_timestamp"
      )
    );
  }

  // ---- Case F: tampered body -> rejected ----
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSignature(SIGNING_SECRET, timestamp, rawBody);

    const tamperedBody = JSON.stringify({ type: "event_callback", event_id: "Ev1-TAMPERED", event: { type: "app_mention" } });

    const result = verifySlackRequest({
      rawBody: tamperedBody,
      timestamp,
      signature,
      signingSecret: SIGNING_SECRET,
    });

    results.push(
      check(
        "[Case F] rawBodyが改ざんされている場合(署名は元のbody分のまま)、ok:false・reason:signature_mismatchを返す",
        result.ok === false && result.reason === "signature_mismatch"
      )
    );
  }

  // ---- 防御的: invalid timestamp(数値化不能) ----
  {
    const result = verifySlackRequest({
      rawBody,
      timestamp: "not-a-number",
      signature: "v0=whatever",
      signingSecret: SIGNING_SECRET,
    });

    results.push(
      check(
        "[防御的] timestampが数値化できない場合、例外を投げずok:false・reason:invalid_timestampを返す",
        result.ok === false && result.reason === "invalid_timestamp"
      )
    );
  }

  // ---- 非漏洩: 拒否結果にsigning secret自体が含まれない ----
  {
    const timestamp = String(Math.floor(Date.now() / 1000));

    const result = verifySlackRequest({
      rawBody,
      timestamp,
      signature: "v0=invalid",
      signingSecret: SIGNING_SECRET,
    });

    results.push(
      check(
        "[非漏洩] 拒否結果(reason)にsigning secretの生値が含まれない",
        !JSON.stringify(result).includes(SIGNING_SECRET)
      )
    );
  }

  return summarize("bot/slackVerifySignature", results);

}
