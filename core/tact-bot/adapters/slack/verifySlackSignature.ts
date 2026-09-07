import { createHmac, timingSafeEqual } from "node:crypto";

// =========================
// TACT Bot — Slack Request Signature Verification (S1a)
// =========================
//
// Slack公式の署名検証アルゴリズム(https://api.slack.com/authentication/
// verifying-requests-from-slack、2026-09時点):
//
//   base string = "v0:{timestamp}:{rawBody}"
//   expected    = "v0=" + HMAC-SHA256(base string, Signing Secret) の16進digest
//   一致確認    = crypto.timingSafeEqual()(タイミング攻撃対策)
//
// 加えてreplay protection: timestampが現在時刻から5分(300秒)以上
// ズレている場合は拒否する(絶対条件Section5)。
//
// 絶対条件: 呼び出し元がJSON.parse()する前のraw request bodyを渡す
// こと(base stringの計算にraw bodyのbyte単位の一致が必要なため、
// JSON.parse→JSON.stringifyで再構成した文字列は元のbyte列と一致する
// 保証が無い)。
//
// node:crypto(Node標準)だけを使う。@slack/*等の外部SDKは一切
// importしない(絶対条件Section3: S1aでは新package追加なし)。
//
// テスト容易性のため、現在時刻をDIできるようにする(`now`省略時は
// Date.now())。

const SLACK_SIGNATURE_VERSION = "v0";

// Slack公式ドキュメントが明示する許容ズレ幅。
const REPLAY_WINDOW_SECONDS = 5 * 60;

export interface VerifySlackRequestParams {

  rawBody: string;

  timestamp: string | null;

  signature: string | null;

  signingSecret: string;

  // テスト用DI。省略時は実際の現在時刻(ミリ秒epoch)を使う。
  now?: () => number;

}

export type VerifySlackRequestResult =
  | { ok: true }
  | {
      ok: false;
      // 絶対条件(Section6): raw secret/error detailを返さない
      // (Slack側の生の署名文字列やHMAC計算過程は一切含めない、
      // 拒否理由の分類ラベルだけを返す)。
      reason:
        | "missing_signature"
        | "missing_timestamp"
        | "invalid_timestamp"
        | "stale_timestamp"
        | "signature_mismatch";
    };

export function verifySlackRequest(
  params: VerifySlackRequestParams
): VerifySlackRequestResult {

  const { rawBody, timestamp, signature, signingSecret, now = Date.now } = params;

  if (!signature) {
    return { ok: false, reason: "missing_signature" };
  }

  if (!timestamp) {
    return { ok: false, reason: "missing_timestamp" };
  }

  const timestampSeconds = Number(timestamp);

  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const nowSeconds = now() / 1000;

  if (Math.abs(nowSeconds - timestampSeconds) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const baseString = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`;

  const expectedDigest = createHmac("sha256", signingSecret)
    .update(baseString, "utf8")
    .digest("hex");

  const expectedSignature = `${SLACK_SIGNATURE_VERSION}=${expectedDigest}`;

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const actualBuffer = Buffer.from(signature, "utf8");

  // timingSafeEqual()は長さが異なるbufferに対して例外を投げるため、
  // 長さ不一致を先にmismatchとして扱う(絶対条件: tampered/不正な
  // signatureでも例外を投げず、判別可能な結果を返す)。
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };

}
