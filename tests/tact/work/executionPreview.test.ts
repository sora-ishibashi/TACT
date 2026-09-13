// =========================
// TACT Work — Canonical Execution Preview (APPROVAL-P2)
// =========================
//
// 対象: core/tact-work/executionPreview.ts / gmailExecutionPreview.ts /
// slackExecutionPreview.ts。完全にpure(DBアクセス・Provider呼び出し・
// LLMのいずれも無い、SIDE-EFFECT FREE PREVIEW絶対条件)。

import { buildExecutionPreview, buildExecutionPreviewFromApprovalPayload } from "../../../core/tact-work/executionPreview";
import { buildGmailSendPreview } from "../../../core/tact-work/gmailExecutionPreview";
import { buildSlackSendPreview } from "../../../core/tact-work/slackExecutionPreview";
import type { SourceReferentSnapshot } from "../../../core/tact-referent/types";
import { check, summarize, type CheckResult } from "../lib/check";

const GMAIL_ACTION = {
  service: "gmail",
  operation: "send_message",
  input: { to: ["tanaka@example.com"], subject: "Re: 更新案件について", bodyText: "本文の内容です。" },
};

const SOURCE_REFERENT: SourceReferentSnapshot = {
  sourceType: "gmail",
  sourceMessageRef: "m-a",
  threadRef: "t-a",
  sender: "tanaka@example.com",
  normalizedSubject: "更新案件について",
  observedAt: "2026-09-13T00:00:00.000Z",
};

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1〜4. Gmail send ActionはExecutionPreviewを構築でき、exact
  // recipient/subject/bodyを持つ ----
  {
    const preview = buildGmailSendPreview(GMAIL_ACTION);

    results.push(check(
      "[APPROVAL-P2] 1. Gmail send ActionはExecutionPreviewを構築する",
      preview !== undefined
    ));

    results.push(check(
      "[APPROVAL-P2] 2. previewはexact recipientを含む",
      !!preview?.fields.some((f) => f.label === "送信先" && f.value === "tanaka@example.com")
    ));

    results.push(check(
      "[APPROVAL-P2] 3. previewはexact subjectを含む",
      !!preview?.fields.some((f) => f.label === "件名" && f.value === "Re: 更新案件について")
    ));

    results.push(check(
      "[APPROVAL-P2] 4. previewはexact bodyを一切要約・truncateせず含む",
      !!preview?.fields.some((f) => f.label === "本文" && f.value === "本文の内容です。")
    ));
  }

  // ---- 5. CC/BCCが存在する場合はfieldとして描画される ----
  {
    const preview = buildGmailSendPreview({
      service: "gmail",
      operation: "send_message",
      input: {
        to: ["tanaka@example.com"],
        cc: ["cc1@example.com"],
        bcc: ["bcc1@example.com"],
        subject: "件名",
        bodyText: "本文",
      },
    });

    results.push(check(
      "[APPROVAL-P2] 5. CC/BCCが存在する場合はfieldとして描画される",
      !!preview?.fields.some((f) => f.label === "CC" && f.value === "cc1@example.com") &&
        !!preview?.fields.some((f) => f.label === "BCC" && f.value === "bcc1@example.com")
    ));
  }

  // ---- 6〜10. effects ----
  {
    const preview = buildGmailSendPreview(GMAIL_ACTION);

    results.push(check("[APPROVAL-P2] 6. effects.externalCommunication = true", preview?.effects.externalCommunication === true));
    results.push(check("[APPROVAL-P2] 7. effects.externalWrite = true", preview?.effects.externalWrite === true));
    results.push(check("[APPROVAL-P2] 8. effects.notification = true", preview?.effects.notification === true));
    results.push(check("[APPROVAL-P2] 9. effects.destructive = false", preview?.effects.destructive === false));
    results.push(check("[APPROVAL-P2] 10. effects.irreversible = true", preview?.effects.irreversible === true));

    // ---- 11. irreversible警告 ----
    results.push(check(
      "[APPROVAL-P2] 11. previewはirreversibleに関する警告文を含む",
      !!preview?.warnings?.some((w) => w.includes("取り消し"))
    ));
  }

  // ---- 12〜13. sourceReferent表示 / 内部ID非露出 ----
  {
    const withReferent = buildGmailSendPreview(GMAIL_ACTION, { sourceReferent: SOURCE_REFERENT });
    const withoutReferent = buildGmailSendPreview(GMAIL_ACTION);

    results.push(check(
      "[APPROVAL-P2] 12. sourceReferentがある場合、human-readableなsender/normalizedSubjectが参照元fieldとして現れる",
      !!withReferent?.fields.some((f) => f.label === "参照元" && f.value.includes("tanaka@example.com") && f.value.includes("更新案件について"))
    ));

    results.push(check(
      "[APPROVAL-P2] 13. sourceMessageRef/threadRefはpreviewのどのfieldにも一切現れない",
      !JSON.stringify(withReferent).includes("m-a") && !JSON.stringify(withReferent).includes("t-a")
    ));

    results.push(check(
      "[APPROVAL-P2] 補助: sourceReferentが無い場合でもpreviewは正常に構築される(absent時も動作する)",
      withoutReferent !== undefined && !withoutReferent.fields.some((f) => f.label === "参照元")
    ));
  }

  // ---- 14. connectionIdは一切現れない(previewはaction.input/context
  // だけを受け取り、connectionId自体を引数として渡していないため
  // 構造的に不可能——念のため直接確認する) ----
  {
    const preview = buildGmailSendPreview(GMAIL_ACTION, { sourceReferent: SOURCE_REFERENT });
    results.push(check(
      "[APPROVAL-P2] 14. previewにconnectionIdという文字列が一切現れない",
      !JSON.stringify(preview).toLowerCase().includes("connectionid") &&
        !JSON.stringify(preview).includes("conn-1")
    ));
  }

  // ---- 15. 生provider payloadが含まれない(TACT canonical inputの
  // fieldだけが渡ることを、想定外の余剰keyが混入しても漏れないことで
  // 確認する) ----
  {
    const preview = buildGmailSendPreview({
      service: "gmail",
      operation: "send_message",
      input: {
        to: ["tanaka@example.com"],
        subject: "件名",
        bodyText: "本文",
        // 想定外のprovider-shaped fieldが紛れ込んでも、previewの
        // fieldとしては一切採用されない(known fieldのみ読む)。
        rawGmailApiPayload: { headers: { "X-Composio-Internal": "secret" } },
      },
    });

    results.push(check(
      "[APPROVAL-P2] 15. 未知のprovider-shaped fieldがinputに混入していても、previewへ一切転記されない",
      !JSON.stringify(preview).includes("X-Composio-Internal") && !JSON.stringify(preview).includes("rawGmailApiPayload")
    ));
  }

  // ---- 16. buildExecutionPreview()自体がProvider呼び出しを一切
  // 行わないpure関数であることの確認(同期的に即値を返す = awaitを
  // 経由しない、非同期I/Oが挟まっていないことの間接証拠)。 ----
  {
    const start = Date.now();
    const preview = buildGmailSendPreview(GMAIL_ACTION);
    const elapsed = Date.now() - start;

    results.push(check(
      "[APPROVAL-P2] 16. buildGmailSendPreview()は同期的に完了する(Provider network callを一切行わない構造的証拠)",
      preview !== undefined && elapsed < 50
    ));
  }

  // ---- Slack send previewも同じregistry経由で構築できる ----
  {
    const preview = buildSlackSendPreview({ service: "slack", operation: "send_message", input: { channel: "#general", text: "こんにちは" } });

    results.push(check(
      "[APPROVAL-P2] Slack send Actionも同じExecutionPreview型で構築でき、exact channel/textを含む",
      !!preview?.fields.some((f) => f.value === "#general") && !!preview?.fields.some((f) => f.value === "こんにちは")
    ));
  }

  // ---- registry dispatch: buildExecutionPreview()はservice.operationで
  // 正しいbuilderへdispatchする ----
  {
    const gmailPreview = buildExecutionPreview(GMAIL_ACTION);
    const slackPreview = buildExecutionPreview({ service: "slack", operation: "send_message", input: { channel: "#x", text: "y" } });

    results.push(check(
      "[APPROVAL-P2] buildExecutionPreview()はservice.operationで正しいbuilderへdispatchする",
      gmailPreview?.service === "gmail" && slackPreview?.service === "slack"
    ));
  }

  // ---- 23. PREVIEW / ACTION MISMATCH: 未登録のservice.operationは
  // fail closed(undefined)——推測で汎用previewを作らない ----
  {
    const preview = buildExecutionPreview({ service: "notion", operation: "update_page", input: { pageId: "p1" } });

    results.push(check(
      "[APPROVAL-P2] 23. 未登録のprotected operation(例: notion.update_page)はfail closed(undefined)であり、当たり障りのない汎用previewを捏造しない",
      preview === undefined
    ));
  }

  // ---- PREVIEW / ACTION MISMATCH: 想定shapeと一致しないinput(欠落
  // フィールド)もfail closed ----
  {
    const preview = buildGmailSendPreview({ service: "gmail", operation: "send_message", input: { to: ["a@example.com"] } });

    results.push(check(
      "[APPROVAL-P2] 想定形式と一致しないinput(subject/bodyText欠落)もfail closed(undefined)",
      preview === undefined
    ));
  }

  // ---- buildExecutionPreviewFromApprovalPayload(): frozen Approval.
  // payloadから決定論的に再構築できる(APPROVAL PERSISTENCE) ----
  {
    const payload = {
      scope: "task",
      action: {
        kind: "external_message",
        summary: "メール返信を送信",
        metadata: {
          service: "gmail",
          operation: "send_message",
          input: GMAIL_ACTION.input,
          connectionId: "conn-1",
          sourceReferent: SOURCE_REFERENT,
        },
      },
    };

    const preview = buildExecutionPreviewFromApprovalPayload(payload);

    results.push(check(
      "[APPROVAL-P2] buildExecutionPreviewFromApprovalPayload()はfrozen Approval.payloadから同じpreviewを再構築する(sourceReferent含む)",
      preview !== undefined &&
        preview.fields.some((f) => f.value === "tanaka@example.com") &&
        preview.fields.some((f) => f.label === "参照元")
    ));

    results.push(check(
      "[APPROVAL-P2] 22. sourceReferentを持たない旧(v1)Approval形式のpayloadでも安全に構築できる(後方互換)",
      buildExecutionPreviewFromApprovalPayload({
        scope: "task",
        action: {
          kind: "external_message",
          summary: "メール返信を送信",
          metadata: { service: "gmail", operation: "send_message", input: GMAIL_ACTION.input, connectionId: "conn-1" },
        },
      }) !== undefined
    ));

    results.push(check(
      "[APPROVAL-P2] connectionId自体はbuildExecutionPreviewFromApprovalPayload()の戻り値にも一切現れない",
      !JSON.stringify(preview).includes("conn-1")
    ));
  }

  // ---- 想定外のpayload形状(action無し/metadata無し)は例外を投げず
  // undefinedを返す(防御的、DB層を信用しない既存方針を踏襲) ----
  {
    let threw = false;
    let result: unknown;
    try {
      result = buildExecutionPreviewFromApprovalPayload({});
    } catch {
      threw = true;
    }

    results.push(check(
      "[APPROVAL-P2] action自体が無いpayloadは例外を投げずundefinedを返す",
      threw === false && result === undefined
    ));
  }

  return summarize("work/executionPreview", results);

}
