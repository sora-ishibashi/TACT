// =========================
// TACT Work — Approval Integrity Regression (Architecture Migration
// ARCH-P1a)
// =========================
//
// 対象: core/tact-work/approvalIntegrity.ts。純粋関数のみ、DB/
// Provider API/Slack/Composioへの依存を一切持たない(importすら
// していないことをこのtest fileの冒頭importが証明する)。
//
// 絶対条件(ARCH-P1a指示、最重要): このtest fileはcore/tact-work/
// approval.tsのrequestApproval()もcore/tact-integration/execution.ts
// のexecuteApprovedIntegrationAction()も一切importしない——ARCH-P1aは
// capture wiring・execution-time verificationのいずれも行わないため、
// それらとの結線を検証する対象がまだ存在しない(ARCH-P1b/P1cのscope)。

import {
  APPROVAL_SUBJECT_VERSION,
  buildApprovalSubject,
  canonicalizeApprovalSubject,
  canonicalizeJsonValue,
  hashApprovalSubject,
  parseStoredApprovalSubject,
  verifyApprovalIntegrity,
  type ApprovalSubject,
  type StoredApprovalSubject,
} from "../../../core/tact-work/approvalIntegrity";
import { check, summarize, type CheckResult } from "../lib/check";

function makeSubject(overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {
  return {
    subjectVersion: APPROVAL_SUBJECT_VERSION,
    workId: "work-1",
    taskId: "task-1",
    service: "slack",
    operation: "send_message",
    canonicalInput: { channel: "general", text: "hello" },
    connectionId: "connection-1",
    riskClassSnapshot: "write",
    ...overrides,
  };
}

function makeStoredFrom(subject: ApprovalSubject): StoredApprovalSubject {
  const canonical = canonicalizeApprovalSubject(subject);
  return {
    version: subject.subjectVersion,
    json: subject as unknown as Record<string, unknown>,
    hash: hashApprovalSubject(canonical),
  };
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Case1: same semantic subject → same canonical serialization ----
  {
    const a = canonicalizeApprovalSubject(makeSubject());
    const b = canonicalizeApprovalSubject(makeSubject());

    results.push(check("[Case1] 同一内容のsubjectは同一canonical文字列になる", a === b));
  }

  // ---- Case2: object key order difference → same canonical result ----
  {
    const a = canonicalizeJsonValue({ channel: "general", text: "hi" });
    const b = canonicalizeJsonValue({ text: "hi", channel: "general" });

    results.push(
      check(
        "[Case2] object keyの挿入順序が違っても同じcanonical文字列になる",
        a.ok && b.ok && JSON.stringify(canonicalStringify(a.value)) === JSON.stringify(canonicalStringify(b.value))
      )
    );
  }

  // ---- Case3: nested object key order difference → same ----
  {
    const a = canonicalizeJsonValue({ outer: { b: 2, a: 1 } });
    const b = canonicalizeJsonValue({ outer: { a: 1, b: 2 } });

    results.push(
      check(
        "[Case3] nested objectのkey順序が違っても同じcanonical文字列になる",
        a.ok && b.ok && canonicalStringify(a.value) === canonicalStringify(b.value)
      )
    );
  }

  // ---- Case4: array order difference → different ----
  {
    const a = canonicalizeJsonValue({ items: [1, 2, 3] });
    const b = canonicalizeJsonValue({ items: [3, 2, 1] });

    results.push(
      check(
        "[Case4] array要素の順序が違えば異なるcanonical文字列になる(順序は意味を持つため保持する)",
        a.ok && b.ok && canonicalStringify(a.value) !== canonicalStringify(b.value)
      )
    );
  }

  // ---- Case5: value difference → different ----
  {
    const a = canonicalizeApprovalSubject(makeSubject({ canonicalInput: { channel: "general", text: "hello" } }));
    const b = canonicalizeApprovalSubject(makeSubject({ canonicalInput: { channel: "general", text: "goodbye" } }));

    results.push(check("[Case5] input内の値が違えば異なるcanonical文字列になる", a !== b));
  }

  // ---- Case6: service difference → different ----
  {
    const a = canonicalizeApprovalSubject(makeSubject({ service: "slack" }));
    const b = canonicalizeApprovalSubject(makeSubject({ service: "gmail" }));

    results.push(check("[Case6] serviceが違えば異なるcanonical文字列になる", a !== b));
  }

  // ---- Case7: operation difference → different ----
  {
    const a = canonicalizeApprovalSubject(makeSubject({ operation: "send_message" }));
    const b = canonicalizeApprovalSubject(makeSubject({ operation: "delete_message" }));

    results.push(check("[Case7] operationが違えば異なるcanonical文字列になる", a !== b));
  }

  // ---- Case8: taskId difference → different ----
  {
    const a = canonicalizeApprovalSubject(makeSubject({ taskId: "task-1" }));
    const b = canonicalizeApprovalSubject(makeSubject({ taskId: "task-2" }));

    results.push(check("[Case8] taskIdが違えば異なるcanonical文字列になる(Task-bound)", a !== b));
  }

  // ---- Case9: workId difference → different ----
  {
    const a = canonicalizeApprovalSubject(makeSubject({ workId: "work-1" }));
    const b = canonicalizeApprovalSubject(makeSubject({ workId: "work-2" }));

    results.push(check("[Case9] workIdが違えば異なるcanonical文字列になる(Work consistency)", a !== b));
  }

  // ---- Case10: connectionId difference → different ----
  {
    const a = canonicalizeApprovalSubject(makeSubject({ connectionId: "connection-1" }));
    const b = canonicalizeApprovalSubject(makeSubject({ connectionId: "connection-2" }));

    results.push(check("[Case10] connectionIdが違えば異なるcanonical文字列になる(credential mutation検知)", a !== b));
  }

  // ---- Case11: riskClassSnapshot difference → different ----
  {
    const a = canonicalizeApprovalSubject(makeSubject({ riskClassSnapshot: "write" }));
    const b = canonicalizeApprovalSubject(makeSubject({ riskClassSnapshot: "destructive" }));

    results.push(check("[Case11] riskClassSnapshotが違えば異なるcanonical文字列になる(policy mutation検知)", a !== b));
  }

  // ---- Case12: null vs omitted → intended semantics ----
  {
    const withNull = canonicalizeJsonValue({ channel: "general", note: null });
    const omitted = canonicalizeJsonValue({ channel: "general" });

    results.push(
      check(
        "[Case12] explicit null(key存在・値null)とkey省略は別物として扱われ、canonical文字列が異なる",
        withNull.ok && omitted.ok && canonicalStringify(withNull.value) !== canonicalStringify(omitted.value)
      )
    );

    results.push(
      check(
        "[Case12] explicit nullは値として保持される(silent dropしない)",
        withNull.ok && canonicalStringify(withNull.value).includes("null")
      )
    );
  }

  // ---- Case13: unsupported explicit undefined → fail ----
  {
    const result = canonicalizeJsonValue({ channel: "general", text: undefined });

    results.push(
      check(
        "[Case13] keyにexplicit undefinedが設定されている場合、silent dropせずexplicit_undefinedとしてfail closedする",
        !result.ok && result.reason === "explicit_undefined"
      )
    );
  }

  // ---- Case14: bigint rejected ----
  {
    const result = canonicalizeJsonValue({ amount: BigInt(100) });

    results.push(
      check("[Case14] bigintは暗黙変換されずunsupported_typeとして拒否される", !result.ok && result.reason === "unsupported_type")
    );
  }

  // ---- Case15: function rejected ----
  {
    const result = canonicalizeJsonValue({ handler: () => {} });

    results.push(
      check("[Case15] functionはunsupported_typeとして拒否される", !result.ok && result.reason === "unsupported_type")
    );
  }

  // ---- Case16: symbol rejected ----
  {
    const result = canonicalizeJsonValue({ tag: Symbol("x") });

    results.push(
      check("[Case16] symbolはunsupported_typeとして拒否される", !result.ok && result.reason === "unsupported_type")
    );
  }

  // ---- Case17: non-finite number rejected ----
  {
    const nan = canonicalizeJsonValue({ value: NaN });
    const inf = canonicalizeJsonValue({ value: Infinity });
    const negInf = canonicalizeJsonValue({ value: -Infinity });

    results.push(
      check(
        "[Case17] NaN/Infinity/-Infinityはいずれもunsupported_typeとして拒否される(JSON表現不可能)",
        !nan.ok && nan.reason === "unsupported_type" &&
          !inf.ok && inf.reason === "unsupported_type" &&
          !negInf.ok && negInf.reason === "unsupported_type"
      )
    );
  }

  // ---- Case18: Date rejected unless explicitly normalized ----
  {
    const result = canonicalizeJsonValue({ when: new Date("2026-09-09T00:00:00.000Z") });

    results.push(
      check(
        "[Case18] Dateオブジェクトは暗黙にstring化されず、unsupported_typeとして拒否される",
        !result.ok && result.reason === "unsupported_type"
      )
    );
  }

  // ---- Case19: circular reference rejected ----
  {
    const circular: Record<string, unknown> = { name: "self" };
    circular.self = circular;

    const result = canonicalizeJsonValue(circular);

    results.push(
      check("[Case19] circular referenceはcircular_referenceとして拒否される", !result.ok && result.reason === "circular_reference")
    );
  }

  // ---- Case20: hash deterministic ----
  {
    const canonical1 = canonicalizeApprovalSubject(makeSubject());
    const canonical2 = canonicalizeApprovalSubject(makeSubject());

    results.push(
      check(
        "[Case20] 同一subjectのhashは何度計算しても同じ値になる(deterministic)",
        hashApprovalSubject(canonical1) === hashApprovalSubject(canonical2)
      )
    );

    results.push(
      check(
        "[Case20] hashはSHA-256の64文字小文字16進digest形式",
        /^[0-9a-f]{64}$/.test(hashApprovalSubject(canonical1))
      )
    );
  }

  // ---- Case21: one-character difference → different hash ----
  {
    const a = hashApprovalSubject(canonicalizeApprovalSubject(makeSubject({ canonicalInput: { channel: "general", text: "hello" } })));
    const b = hashApprovalSubject(canonicalizeApprovalSubject(makeSubject({ canonicalInput: { channel: "general", text: "hellp" } })));

    results.push(check("[Case21] 1文字の差でも異なるhashになる", a !== b));
  }

  // ---- Case22: malformed stored hash → hash_mismatch ----
  {
    const subject = makeSubject();
    const stored = makeStoredFrom(subject);

    const corrupted: StoredApprovalSubject = { ...stored, hash: "0".repeat(64) };

    const check1 = verifyApprovalIntegrity(corrupted, subject);

    results.push(
      check(
        "[Case22] stored.hashがsubject_jsonと一致しない場合、hash_mismatchとして安全に拒否される",
        check1.result === "hash_mismatch"
      )
    );
  }

  // ---- Case23: unsupported subject version → version_unsupported ----
  {
    const subject = makeSubject();
    const stored = makeStoredFrom(subject);

    const wrongVersion: StoredApprovalSubject = { ...stored, version: 999 };
    const nullVersion: StoredApprovalSubject = { ...stored, version: null };

    const r1 = verifyApprovalIntegrity(wrongVersion, subject);
    const r2 = verifyApprovalIntegrity(nullVersion, subject);

    results.push(
      check(
        "[Case23] サポート外のsubject_version(未知の数値)はversion_unsupportedとしてfail closedする",
        r1.result === "version_unsupported"
      )
    );

    results.push(
      check(
        "[Case23] subject_versionがnull(未capture)の場合もversion_unsupportedとしてfail closedする",
        r2.result === "version_unsupported"
      )
    );
  }

  // ---- Case24: pure functions do not mutate input ----
  {
    const original = { channel: "general", nested: { a: 1 } };
    const snapshot = JSON.parse(JSON.stringify(original));

    canonicalizeJsonValue(original);

    results.push(
      check(
        "[Case24] canonicalizeJsonValue()は入力を一切mutateしない",
        JSON.stringify(original) === JSON.stringify(snapshot)
      )
    );

    const subject = makeSubject();
    const subjectSnapshot = JSON.parse(JSON.stringify(subject));

    canonicalizeApprovalSubject(subject);

    results.push(
      check(
        "[Case24] canonicalizeApprovalSubject()は入力を一切mutateしない",
        JSON.stringify(subject) === JSON.stringify(subjectSnapshot)
      )
    );
  }

  // ---- 追加: match(完全一致)のpositive case ----
  {
    const subject = makeSubject();
    const stored = makeStoredFrom(subject);

    const result = verifyApprovalIntegrity(stored, makeSubject());

    results.push(check("[match] 完全に一致するsubjectはmatchを返す", result.result === "match"));
  }

  // ---- 追加: subject_mismatch — 内容が変化した場合、変化したfield名を報告する ----
  {
    const original = makeSubject();
    const stored = makeStoredFrom(original);

    const mutated = makeSubject({ canonicalInput: { channel: "general", text: "changed" } });

    const result = verifyApprovalIntegrity(stored, mutated);

    results.push(
      check(
        "[subject_mismatch] payload(canonicalInput)が変化した場合、subject_mismatchとcanonicalInputを含むmismatchedFieldsを返す",
        result.result === "subject_mismatch" && result.mismatchedFields.includes("canonicalInput")
      )
    );
  }

  // ---- 追加: stored_subject_invalid — 壊れた/形が違うstored.json ----
  {
    const subject = makeSubject();
    const stored = makeStoredFrom(subject);

    const malformed: StoredApprovalSubject = { ...stored, json: { garbage: true } };

    const result = verifyApprovalIntegrity(malformed, subject);

    results.push(
      check(
        "[stored_subject_invalid] stored.jsonがApprovalSubjectとして解釈できない形の場合、安全に拒否される",
        result.result === "stored_subject_invalid"
      )
    );
  }

  // ---- 追加: stored_subject_invalid — DB列とsubject内部versionの食い違い(single source of truth不整合) ----
  {
    const subject = makeSubject();
    const stored = makeStoredFrom(subject);

    // subject_json自体は正しいversion=1のままだが、DB列(version)だけ
    // 別の値になっている(データ破損/不整合のシミュレーション)。
    const inconsistent: StoredApprovalSubject = { ...stored, version: 1, json: { ...(stored.json as object), subjectVersion: 2 } };

    const result = verifyApprovalIntegrity(inconsistent, subject);

    results.push(
      check(
        "[stored_subject_invalid] DB列のversionとsubject_json内部のsubjectVersionが食い違う場合、stored_subject_invalidとして拒否される(single source of truthの不整合検知)",
        result.result === "stored_subject_invalid"
      )
    );
  }

  // ---- 追加: buildApprovalSubject() — 正常系 ----
  {
    const result = buildApprovalSubject({
      workId: "work-1",
      taskId: "task-1",
      service: "slack",
      operation: "send_message",
      input: { channel: "general", text: "hello" },
      connectionId: "connection-1",
      riskClassSnapshot: "write",
    });

    results.push(
      check(
        "[buildApprovalSubject] 正常なinputからApprovalSubjectを構築できる、subjectVersionはAPPROVAL_SUBJECT_VERSION",
        result.ok && result.subject.subjectVersion === APPROVAL_SUBJECT_VERSION
      )
    );
  }

  // ---- 追加: buildApprovalSubject() — 不正なinputはfail closed ----
  {
    const result = buildApprovalSubject({
      workId: "work-1",
      taskId: "task-1",
      service: "slack",
      operation: "send_message",
      input: { channel: "general", handler: () => {} },
      connectionId: "connection-1",
      riskClassSnapshot: "write",
    });

    results.push(
      check(
        "[buildApprovalSubject] inputにunsupportedな値(function等)が含まれる場合、silent dropせずfail closedする",
        !result.ok && result.reason === "unsupported_type"
      )
    );
  }

  // ---- 追加: parseStoredApprovalSubject() — 型のvalidation ----
  {
    results.push(
      check(
        "[parseStoredApprovalSubject] nullはundefinedを返す(missing/invalidを区別しない安全側)",
        parseStoredApprovalSubject(null) === undefined
      )
    );

    results.push(
      check(
        "[parseStoredApprovalSubject] 配列はundefinedを返す",
        parseStoredApprovalSubject([1, 2, 3]) === undefined
      )
    );

    results.push(
      check(
        "[parseStoredApprovalSubject] 必須fieldが欠けたobjectはundefinedを返す",
        parseStoredApprovalSubject({ workId: "work-1" }) === undefined
      )
    );

    results.push(
      check(
        "[parseStoredApprovalSubject] 正しい形のsubjectは正しくparseされる",
        parseStoredApprovalSubject(makeSubject() as unknown as Record<string, unknown>)?.workId === "work-1"
      )
    );
  }

  return summarize("work/approvalIntegrity", results);

}

// テスト専用の比較補助(本体のstableStringify()相当をexportしていない
// ため、順序非依存の比較にはJSON.stringify(canonicalizeされたJsonValue)
// を使う——object自体は既にcanonicalizeJsonValue()でsort前のvalidation
// を通過済みだが、このヘルパーはtest側で「意味的に同じかどうか」を
// 確認するためだけの薄いwrapper)。
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}
