// =========================
// TACT Referent — ReferentSignal Extraction Regression (REF-P1b)
// =========================
//
// 対象: core/tact-referent/signals.ts。Slack/Gmail/Composio/
// Supabase/LLMのいずれにも接続しない、純粋関数のみのtest。

import { extractReferentSignals } from "../../../core/tact-referent/signals";
import { slackMessage } from "./fixtures";
import { check, summarize, type CheckResult } from "../lib/check";
import type { ReferentSignal } from "../../../core/tact-referent/types";

const REFERENCE_TIME = new Date("2026-09-11T09:00:00.000Z");

function hasSignal(
  signals: readonly ReferentSignal[],
  predicate: (signal: ReferentSignal) => boolean
): boolean {
  return signals.some(predicate);
}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // 1. Slack provenanceを持つentity signal
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 1. Slack由来のentity signalがslack_message_ref provenanceを持つ",
        hasSignal(
          signals,
          (s) => s.kind === "entity" && s.value === "A社" && s.provenance.kind === "slack_message_ref" && s.provenance.messageRef === "s1"
        )
      )
    );
  }

  // 2. Work subject signal(work_subject provenance)
  {
    const signals = extractReferentSignals({
      priorMessages: [],
      currentTriggerText: "これ確認して",
      workSubject: "TACTテスト商事の更新案件",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 2. Work.subjectはkind=subject・provenance.kind=work_subjectとして1件だけ現れる",
        signals.filter((s) => s.provenance.kind === "work_subject").length === 1 &&
          hasSignal(signals, (s) => s.kind === "subject" && s.value === "TACTテスト商事の更新案件" && s.provenance.kind === "work_subject")
      )
    );
  }

  // 3. 明示的なsubject hint(引用+メール文脈)
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "「更新案件の追加確認」ってメール来てる" })],
      currentTriggerText: "これ対応しといて",
      requestType: "act",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 3. 「」で囲まれ、かつメール文脈を伴う引用はsubject signalとして抽出される",
        hasSignal(signals, (s) => s.kind === "subject" && s.value === "更新案件の追加確認" && s.provenance.kind === "slack_message_ref")
      )
    );

    const noEmailContext = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "「更新案件の追加確認」って言ってた気がする" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 3b. communication文脈語(メール/gmail/件名等)を伴わない引用はsubject signalにならない(Work subjectを無条件にsubject化しない、という原則の裏取り)",
        !hasSignal(noEmailContext, (s) => s.kind === "subject" && s.value === "更新案件の追加確認")
      )
    );
  }

  // 4. 明示的な氏名sender
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "田中さんから連絡来てた" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 4. 「田中さんから」は明示的なsender signalとして抽出される",
        hasSignal(signals, (s) => s.kind === "sender" && s.value === "田中さん")
      )
    );
  }

  // 5. 明示的なメールアドレスsender
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "tanaka@example.comから返信あった" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 5. メールアドレス+「から」は明示的なsender signalとして抽出される",
        hasSignal(signals, (s) => s.kind === "sender" && s.value === "tanaka@example.com")
      )
    );
  }

  // 6. 企業/entityへの単純な言及は自動的にsenderにならない
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "A社の件、対応必要かも" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 6. 「から」を伴わない単なる企業言及(A社の件)はsender signalにならない(entityとsenderを混同しない)",
        hasSignal(signals, (s) => s.kind === "entity" && s.value === "A社") &&
          !hasSignal(signals, (s) => s.kind === "sender")
      )
    );

    const withKara = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "TACTテスト商事から更新案件の追加確認メール来てる" })],
      currentTriggerText: "これ対応しといて",
      requestType: "act",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 6b. 「TACTテスト商事から」のように明示的な「から」が伴う場合のみ、entityとは別にsender signalも生成される",
        hasSignal(withKara, (s) => s.kind === "entity" && s.value === "TACTテスト商事") &&
          hasSignal(withKara, (s) => s.kind === "sender" && s.value === "TACTテスト商事")
      )
    );
  }

  // 7. 「昨日」direct signal
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "昨日のメールの件だけど" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 7. 「昨日」はdirectなtime signalとして抽出される",
        hasSignal(signals, (s) => s.kind === "time" && s.directness === "direct" && s.value === "昨日")
      )
    );
  }

  // 8. 「昨日」からの決定論的なinferred date
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "昨日のメールの件だけど" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    results.push(
      check(
        "[REF-P1b signals] 8. 「昨日」はreferenceTime(2026-09-11)を基準にinferredなISO日付(2026-09-10)へ決定論的に変換される",
        hasSignal(signals, (s) => s.kind === "time" && s.directness === "inferred" && s.value === "2026-09-10")
      )
    );
  }

  // 9. action signalは既存requestTypeからのみ導出される
  {
    const signals = extractReferentSignals({
      priorMessages: [],
      currentTriggerText: "これ確認して",
      requestType: "act",
      referenceTime: REFERENCE_TIME,
    });

    const actionSignals = signals.filter((s) => s.kind === "action");

    results.push(
      check(
        "[REF-P1b signals] 9. action signalはちょうど1件、渡されたrequestType(\"act\")の値をそのまま持つ(独自の意図再分類をしない)",
        actionSignals.length === 1 && actionSignals[0].value === "act" && actionSignals[0].provenance.kind === "current_trigger"
      )
    );
  }

  // 10. historical messageはrequestTypeを上書きできない
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "これ削除して送信して実行して" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    const actionSignals = signals.filter((s) => s.kind === "action");

    results.push(
      check(
        "[REF-P1b signals] 10. 過去メッセージが強いaction的な文言(削除/送信/実行)を含んでいても、action signalは呼び出し元が渡した既存requestType(\"inspect\")のまま変わらない",
        actionSignals.length === 1 && actionSignals[0].value === "inspect"
      )
    );
  }

  // 11. 生のprovider本文/snippetを一切含まない
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "A社の更新案件について、詳細は先方からの添付資料を参照" })],
      currentTriggerText: "これ確認して",
      workSubject: "TACTテスト商事の更新案件",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    const serialized = JSON.stringify(signals);

    results.push(
      check(
        "[REF-P1b signals] 11. 生成されたsignal配列は、元のSlack本文全体やGmail本文/snippet相当のfieldを一切含まない(bounded valueのみ)",
        !serialized.includes("添付資料を参照") && !serialized.includes("bodyText") && !serialized.includes("snippet")
      )
    );
  }

  // 12. authorizationセマンティクスを一切含まない
  {
    const signals = extractReferentSignals({
      priorMessages: [],
      currentTriggerText: "これ対応しといて",
      requestType: "act",
      referenceTime: REFERENCE_TIME,
    });

    const serialized = JSON.stringify(signals).toLowerCase();

    results.push(
      check(
        "[REF-P1b signals] 12. signalにapproval/authorization相当のfield・語彙が一切含まれない",
        !serialized.includes("approv") && !serialized.includes("authoriz") && !serialized.includes("policy")
      )
    );
  }

  // 13. 同一provenance内の重複signalは決定論的にdedupされる
  {
    const signals = extractReferentSignals({
      priorMessages: [slackMessage({ messageRef: "s1", text: "A社の件、A社から来た。" })],
      currentTriggerText: "これ確認して",
      requestType: "inspect",
      referenceTime: REFERENCE_TIME,
    });

    const entitySignalsForS1 = signals.filter(
      (s) => s.kind === "entity" && s.value === "A社" && s.provenance.kind === "slack_message_ref" && s.provenance.messageRef === "s1"
    );

    results.push(
      check(
        "[REF-P1b signals] 13. 同一メッセージ内でA社が2回言及されても、同一provenanceのentity signalは1件にdedupされる",
        entitySignalsForS1.length === 1
      )
    );
  }

  // 14. 同一inputに対する出力順序の決定論性
  {
    const input = {
      priorMessages: [
        slackMessage({ messageRef: "s1", text: "A社の更新案件どうなってる？" }),
        slackMessage({ messageRef: "s2", text: "田中さんから昨日メール来てた" }),
      ],
      currentTriggerText: "これ対応しといて",
      workSubject: "TACTテスト商事の更新案件",
      requestType: "act" as const,
      referenceTime: REFERENCE_TIME,
    };

    const first = extractReferentSignals(input);
    const second = extractReferentSignals(input);

    results.push(
      check(
        "[REF-P1b signals] 14. 同一inputに対しextractReferentSignals()は常に同一の順序・内容を返す(決定論的)",
        JSON.stringify(first) === JSON.stringify(second)
      )
    );
  }

  return summarize("referent/signals", results);

}
