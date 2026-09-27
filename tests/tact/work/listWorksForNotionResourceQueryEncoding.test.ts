// =========================
// TACT Work Store — listWorksForNotionResource() jsonb containment
// query encoding (SOR-53 hardening, Defect 1)
// =========================
//
// 背景(SOR-55実Staging検証で発見): core/tact-work/store.tsの
// listWorksForNotionResource()は`.contains("evidence_refs", [{...}])`
// へ生のJS object配列をそのまま渡していた。real Postgres/PostgRESTに
// 対しては、supabase-js/postgrest-jsがこれをArray.prototype.toString()
// 相当("[object Object]")で直列化し、`cs.{[object Object]}`という
// 不正なjsonbリテラルを送ってしまい、Postgresが22P02
// ("invalid input syntax for type json")で拒否する。
//
// この直列化はclient側(supabase-js)のURL構築処理そのものであり、
// サーバーへ実際に接続しなくても、`@supabase/supabase-js`の
// `PostgrestFilterBuilder`が構築するrequest URLを直接検査するだけで
// 検証できる(=「real Supabase-compatible path」——実際にnetwork呼び
// 出しをせずとも、実際のsupabase-jsライブラリが生成する、real
// PostgRESTサーバーへ送られるのと全く同じrequest URLを検証する)。
// 既存のmockベースのcorrelation stage test(notionEvidence.test.ts)は
// listWorksForNotionResource自体をDIで差し替えているため、この
// client-side直列化のbugを検出できなかった——このfileはその隙間を
// 埋める。
//
// 絶対条件(既存規約、storeAuthorization.test.ts冒頭コメント参照):
// このfile自体は実Supabaseへ接続しない(fake URL/anon keyでclientを
// 作り、`.url`を同期的に読むだけ——awaitしない、つまりnetwork I/Oは
// 一切発生しない)。

import { createClient } from "@supabase/supabase-js";
import { check, summarize, type CheckResult } from "../lib/check";

const FAKE_URL = "https://sor53-test-project.supabase.co";
const FAKE_ANON_KEY = "fake-anon-key-for-query-construction-only";

function buildContainsUrl(value: string | ReadonlyArray<unknown> | Record<string, unknown>): string {
  const client = createClient(FAKE_URL, FAKE_ANON_KEY, { auth: { persistSession: false } });
  const builder = client
    .from("tact_works")
    .select("id")
    .eq("user_id", "00000000-0000-0000-0000-000000000000")
    .contains("evidence_refs", value as never)
    .order("updated_at", { ascending: false });
  // PostgrestFilterBuilder exposes its constructed URL synchronously
  // before the query is ever awaited/executed (no network I/O happens
  // here).
  return (builder as unknown as { url: URL }).url.toString();
}

function evidenceRefsParam(url: string): string {
  const parsed = new URL(url);
  const raw = parsed.searchParams.get("evidence_refs") ?? "";
  // Postgrest's "cs." (contains) operator prefix.
  return raw.startsWith("cs.") ? raw.slice("cs.".length) : raw;
}

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  const buggyUrl = buildContainsUrl([{ sourceType: "notion", sourceRef: "page-1" }]);
  const buggyParam = evidenceRefsParam(buggyUrl);

  results.push(check(
    "[Regression proof] the OLD call shape (raw JS array of objects) really does produce the reported malformed value ([object Object])",
    buggyParam.includes("[object Object]")
  ));

  const fixedUrl = buildContainsUrl(JSON.stringify([{ sourceType: "notion", sourceRef: "page-1" }]));
  const fixedParam = evidenceRefsParam(fixedUrl);

  results.push(check(
    "[Fix] the current call shape (JSON.stringify'd string, as used in core/tact-work/store.ts) does not contain \"[object Object]\"",
    !fixedParam.includes("[object Object]")
  ));

  let parsedOk = false;
  let parsedValue: unknown = null;
  try {
    parsedValue = JSON.parse(decodeURIComponent(fixedParam));
    parsedOk = true;
  } catch {
    parsedOk = false;
  }

  results.push(check(
    "[Fix] the fixed evidence_refs query value is valid, parseable JSON (would not trigger Postgres 22P02)",
    parsedOk
  ));

  results.push(check(
    "[Fix] the parsed containment value preserves sourceType/sourceRef semantics unchanged",
    parsedOk &&
      Array.isArray(parsedValue) &&
      (parsedValue as Array<{ sourceType?: string; sourceRef?: string }>).length === 1 &&
      (parsedValue as Array<{ sourceType?: string; sourceRef?: string }>)[0].sourceType === "notion" &&
      (parsedValue as Array<{ sourceType?: string; sourceRef?: string }>)[0].sourceRef === "page-1"
  ));

  return summarize("TACT Work Store — listWorksForNotionResource() query encoding (SOR-53 Defect 1 fix)", results);
}
