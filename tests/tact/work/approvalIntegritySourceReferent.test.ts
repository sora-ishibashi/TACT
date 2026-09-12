// =========================
// TACT Work — Approval Integrity SourceReferent Regression (REF-P1e)
// =========================
//
// 対象: core/tact-work/approvalIntegrity.tsのsourceReferent対応
// (ApprovalSubject.sourceReferent / buildApprovalSubject() /
// parseStoredApprovalSubject() / parseSourceReferentSnapshot() /
// verifyApprovalIntegrity())。純粋関数のみ、DB/Provider API依存なし
// (既存tests/tact/work/approvalIntegrity.test.tsと同じ方針)。
//
// 絶対条件(このphaseの明示的設計判断): APPROVAL_SUBJECT_VERSIONは
// 1のまま変更していない——sourceReferentは完全にadditive/optionalな
// fieldであり、既存v1 Approval(このfieldを持たない)の動作・
// canonical文字列表現に一切影響しない。

import {
  APPROVAL_SUBJECT_VERSION,
  buildApprovalSubject,
  canonicalizeApprovalSubject,
  hashApprovalSubject,
  parseSourceReferentSnapshot,
  parseStoredApprovalSubject,
  verifyApprovalIntegrity,
  type ApprovalSubject,
  type StoredApprovalSubject,
} from "../../../core/tact-work/approvalIntegrity";
import type { SourceReferentSnapshot } from "../../../core/tact-referent/types";
import { check, summarize, type CheckResult } from "../lib/check";

const SOURCE_REFERENT: SourceReferentSnapshot = {
  sourceType: "gmail",
  sourceMessageRef: "m-a",
  threadRef: "t-a",
  sender: "tanaka@example.com",
  normalizedSubject: "更新案件について",
  observedAt: "2026-09-11T00:00:00.000Z",
};

function makeSubject(sourceReferent: SourceReferentSnapshot | null, overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {
  const result = buildApprovalSubject({
    workId: "work-1",
    taskId: "task-1",
    service: "gmail",
    operation: "send_message",
    input: { to: ["tanaka@example.com"], subject: "Re: 更新案件について", bodyText: "本文" },
    connectionId: "conn-1",
    riskClassSnapshot: "write",
    sourceReferent,
  });
  if (!result.ok) throw new Error("test fixture itself must be buildable");
  return { ...result.subject, ...overrides };
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

  // ---- 1. buildApprovalSubject()はsourceReferentをそのまま埋め込む ----
  {
    const subject = makeSubject(SOURCE_REFERENT);
    results.push(
      check(
        "[REF-P1e approvalIntegrity] 1. buildApprovalSubject()はsourceReferentをsubjectへそのまま埋め込む",
        JSON.stringify(subject.sourceReferent) === JSON.stringify(SOURCE_REFERENT)
      )
    );
  }

  // ---- 2. sourceReferent無しではsubjectVersionは変わらない(v1のまま) ----
  {
    const withReferent = makeSubject(SOURCE_REFERENT);
    const withoutReferent = makeSubject(null);
    results.push(
      check(
        "[REF-P1e approvalIntegrity] 2. sourceReferentの有無に関わらずsubjectVersionは常にAPPROVAL_SUBJECT_VERSION(1)のまま——ApprovalSubject v2のような新バージョンを導入していない(既存v1 Approvalとの後方互換性を型/バージョン番号レベルで保証)",
        withReferent.subjectVersion === APPROVAL_SUBJECT_VERSION && withoutReferent.subjectVersion === APPROVAL_SUBJECT_VERSION
      )
    );
  }

  // ---- 3. sourceReferent無しの場合、subject自体にkeyが一切現れない ----
  {
    const subject = makeSubject(null);
    results.push(
      check(
        "[REF-P1e approvalIntegrity] 3. sourceReferentを渡さない場合、subjectオブジェクトにsourceReferentというkeyそのものが存在しない(explicit undefinedではなく、キー自体が無い)",
        !("sourceReferent" in subject)
      )
    );
  }

  // ---- 4. unchanged referent -> match ----
  {
    const stored = makeStoredFrom(makeSubject(SOURCE_REFERENT));
    const current = makeSubject(SOURCE_REFERENT);
    const check1 = verifyApprovalIntegrity(stored, current);
    results.push(check("[REF-P1e approvalIntegrity] 4. sourceReferentが変わっていなければmatch", check1.result === "match"));
  }

  // ---- 5-8. 各fieldの改ざんはすべてsubject_mismatchになる ----
  {
    const stored = makeStoredFrom(makeSubject(SOURCE_REFERENT));

    const changedMessageRef = verifyApprovalIntegrity(stored, makeSubject({ ...SOURCE_REFERENT, sourceMessageRef: "m-b" }));
    const changedThreadRef = verifyApprovalIntegrity(stored, makeSubject({ ...SOURCE_REFERENT, threadRef: "t-b" }));
    const changedSender = verifyApprovalIntegrity(stored, makeSubject({ ...SOURCE_REFERENT, sender: "attacker@example.com" }));
    const changedSubject = verifyApprovalIntegrity(stored, makeSubject({ ...SOURCE_REFERENT, normalizedSubject: "別件について" }));

    results.push(check("[REF-P1e approvalIntegrity] 5. sourceMessageRef変更はsubject_mismatch", changedMessageRef.result === "subject_mismatch"));
    results.push(check("[REF-P1e approvalIntegrity] 6. threadRef変更はsubject_mismatch", changedThreadRef.result === "subject_mismatch"));
    results.push(check("[REF-P1e approvalIntegrity] 7. sender変更はsubject_mismatch", changedSender.result === "subject_mismatch"));
    results.push(check("[REF-P1e approvalIntegrity] 8. normalizedSubject変更はsubject_mismatch", changedSubject.result === "subject_mismatch"));

    if (changedMessageRef.result === "subject_mismatch") {
      results.push(
        check(
          "[REF-P1e approvalIntegrity] 補助: mismatchedFieldsにsourceReferentが正しく含まれる(内部診断)",
          changedMessageRef.mismatchedFields.includes("sourceReferent")
        )
      );
    }
  }

  // ---- 9. Action input(recipient)変更は、sourceReferentが同一でもmismatch(既存保護維持) ----
  {
    const stored = makeStoredFrom(makeSubject(SOURCE_REFERENT));
    const tamperedAction = buildApprovalSubject({
      workId: "work-1", taskId: "task-1", service: "gmail", operation: "send_message",
      input: { to: ["attacker@example.com"], subject: "Re: 更新案件について", bodyText: "本文" },
      connectionId: "conn-1", riskClassSnapshot: "write", sourceReferent: SOURCE_REFERENT,
    });
    if (!tamperedAction.ok) throw new Error("fixture must build");
    const check9 = verifyApprovalIntegrity(stored, tamperedAction.subject);
    results.push(check("[REF-P1e approvalIntegrity] 9. sourceReferentが同一でもAction input(to)改ざんはsubject_mismatchになる(referent保護追加で既存Action保護が弱まっていない)", check9.result === "subject_mismatch"));
  }

  // ---- 10. V1(sourceReferent無し)同士の比較は、このphase以前と全く同じくmatchする ----
  {
    const stored = makeStoredFrom(makeSubject(null));
    const current = makeSubject(null);
    const check10 = verifyApprovalIntegrity(stored, current);
    results.push(check("[REF-P1e approvalIntegrity] 10. V1(sourceReferent無し)同士の比較は引き続きmatchする(後方互換性)", check10.result === "match"));
  }

  // ---- 11. stored側にsourceReferentが無く、current側にはある(非対称) -> mismatch(fail closed、勝手にreferent-awareへ格上げしない) ----
  {
    const stored = makeStoredFrom(makeSubject(null));
    const current = makeSubject(SOURCE_REFERENT);
    const check11 = verifyApprovalIntegrity(stored, current);
    results.push(
      check(
        "[REF-P1e approvalIntegrity] 11. storedがV1(referent無し)なのにcurrentがreferentを持つ非対称な場合もmismatchとしてfail closedする(黙って新しいreferentを受理しない)",
        check11.result === "subject_mismatch"
      )
    );
  }

  // ---- 12. parseSourceReferentSnapshot(): 正常/異常values ----
  {
    const valid = parseSourceReferentSnapshot(SOURCE_REFERENT);
    const wrongType = parseSourceReferentSnapshot({ ...SOURCE_REFERENT, sourceType: "slack" });
    const missingSender = parseSourceReferentSnapshot({ sourceType: "gmail", sourceMessageRef: "m-a", normalizedSubject: "x" });
    const notAnObject = parseSourceReferentSnapshot("not-an-object");
    const nullValue = parseSourceReferentSnapshot(null);

    results.push(
      check(
        "[REF-P1e approvalIntegrity] 12. parseSourceReferentSnapshot()は正常な形のみ受理し、sourceType不一致・必須field欠如・非objectはすべてundefinedを返す(fail closed)",
        valid?.sourceMessageRef === SOURCE_REFERENT.sourceMessageRef &&
          valid?.sender === SOURCE_REFERENT.sender &&
          valid?.normalizedSubject === SOURCE_REFERENT.normalizedSubject &&
          valid?.threadRef === SOURCE_REFERENT.threadRef &&
          valid?.observedAt === SOURCE_REFERENT.observedAt &&
          wrongType === undefined && missingSender === undefined && notAnObject === undefined && nullValue === undefined
      )
    );
  }

  // ---- 13. parseStoredApprovalSubject(): storedのsourceReferentが壊れている場合、subject全体を無効とする ----
  {
    const subject = makeSubject(SOURCE_REFERENT);
    const corruptedJson = { ...subject, sourceReferent: { sourceType: "gmail" /* sourceMessageRef欠如 */ } };
    const parsed = parseStoredApprovalSubject(corruptedJson);
    results.push(
      check(
        "[REF-P1e approvalIntegrity] 13. stored subject内のsourceReferentが不正な形の場合、parseStoredApprovalSubject()はsubject全体をundefinedとして拒否する(改ざん/破損の兆候として扱う)",
        parsed === undefined
      )
    );
  }

  // ---- 14. parseStoredApprovalSubject(): sourceReferentが無いv1形式は引き続き正常にparseできる ----
  {
    const subject = makeSubject(null);
    const parsed = parseStoredApprovalSubject(subject as unknown as Record<string, unknown>);
    results.push(
      check(
        "[REF-P1e approvalIntegrity] 14. sourceReferentを持たないv1形式のstored subjectは引き続き正常にparseできる(後方互換性)",
        parsed !== undefined && !("sourceReferent" in parsed)
      )
    );
  }

  // ---- 15. round-trip: JSON往復後もhashは一致する(DB jsonb round-trip相当) ----
  {
    const subject = makeSubject(SOURCE_REFERENT);
    const roundTripped = JSON.parse(JSON.stringify(subject));
    const originalHash = hashApprovalSubject(canonicalizeApprovalSubject(subject));
    const parsedBack = parseStoredApprovalSubject(roundTripped);
    const roundTrippedHash = parsedBack ? hashApprovalSubject(canonicalizeApprovalSubject(parsedBack)) : undefined;

    results.push(
      check(
        "[REF-P1e approvalIntegrity] 15. sourceReferentを含むsubjectはJSON round-trip(DB jsonb相当)後も同一hashを再現する",
        parsedBack !== undefined && originalHash === roundTrippedHash
      )
    );
  }

  return summarize("work/approvalIntegritySourceReferent", results);

}
