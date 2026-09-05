// =========================
// TACT Artifact Mutation Regression (Phase 75)
// =========================
//
// 対象: core/tact-conversation/artifactMutation.ts(純粋関数のみ、
// DB/LLM/Search API呼び出しなし)、core/tact-artifact/store.tsの
// toArtifact()/toArtifactSummary()(row↔domain変換、純粋関数)。
//
// 絶対条件(Phase75 Section15): tact_artifacts /
// tact_conversations.artifact_idのmigrationはユーザー承認待ちで実DBへ
// 未適用のため、このテストは実DBアクセスを一切行わない
// (Reality Testはmigration承認後に別途実施し、完了報告に記載する)。

import {
  detectArtifactMutationIntent,
  deriveArtifactTitle,
  buildArtifactSectionContent,
  appendArtifactContent,
  buildArtifactMutationConfirmation,
} from "../../../core/tact-conversation/artifactMutation";
import { toArtifact, toArtifactSummary, type ArtifactRow } from "../../../core/tact-artifact/store";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- detectArtifactMutationIntent(): Case A/B(更新しない) ----

  results.push(
    check(
      "[CaseA] 挨拶「こんにちは」+ capability='orchestrator' -> false(Artifact更新しない)",
      detectArtifactMutationIntent("こんにちは", "orchestrator") === false
    )
  );

  results.push(
    check(
      "[CaseB] 単純質問「この調査って結局何が重要?」+ capability='orchestrator' -> false",
      detectArtifactMutationIntent("この調査って結局何が重要？", "orchestrator") === false
    )
  );

  results.push(
    check(
      "[CaseB類似] 「結論を教えて」(質問形、更新指示ではない) -> false(誤検出しない)",
      detectArtifactMutationIntent("結論を教えて", "orchestrator") === false
    )
  );

  // ---- detectArtifactMutationIntent(): Case C(Research capability) ----

  results.push(
    check(
      "[CaseC] capability='research' -> true(入力文言に関わらず、Research実行自体がsignal)",
      detectArtifactMutationIntent("中京大学のスポーツ系ゼミについて調査して", "research") === true
    )
  );

  // ---- detectArtifactMutationIntent(): Case D/E/F(明示的指示、chatフォールバック経路) ----

  results.push(
    check(
      "[CaseD] 「他大学の事例も追加して」+ capability='orchestrator' -> true",
      detectArtifactMutationIntent("他大学の事例も追加して", "orchestrator") === true
    )
  );

  results.push(
    check(
      "[CaseE] 「この比較をグラフにして」+ capability='orchestrator' -> true",
      detectArtifactMutationIntent("この比較をグラフにして", "orchestrator") === true
    )
  );

  results.push(
    check(
      "[CaseF] 「大学ごとに表にまとめて」+ capability='orchestrator' -> true",
      detectArtifactMutationIntent("大学ごとに表にまとめて", "orchestrator") === true
    )
  );

  results.push(
    check(
      "[Case明示] 「これを成果物に追加して」+ capability='orchestrator' -> true",
      detectArtifactMutationIntent("これを成果物に追加して", "orchestrator") === true
    )
  );

  // ---- deriveArtifactTitle(): pure ----

  results.push(
    check(
      "[Title1] 短い入力はそのまま",
      deriveArtifactTitle("中京大学について") === "中京大学について"
    )
  );

  {
    const longInput = "あ".repeat(50);
    const title = deriveArtifactTitle(longInput);
    results.push(
      check(
        "[Title2] 40文字を超える入力は切り詰められる(...付き)",
        title.endsWith("...") && title.length === 43,
        `title.length=${title.length}`
      )
    );
  }

  // ---- buildArtifactSectionContent(): pure ----

  {
    // Phase77-A: deriveArtifactTitle()が「について調べて」等の命令文の
    // 語尾を取り除くよう改善されたため(Section2)、見出しは命令文を
    // 含まない短い形になる。
    const section = buildArtifactSectionContent("中京大学について調べて", "調査結果本文");
    results.push(
      check(
        "[Section1] 見出し(##)+タイトル(命令文を含まない)+本文の形になる",
        section.startsWith("## 中京大学") &&
          !section.includes("調べて") &&
          section.includes("調査結果本文"),
        `section=${JSON.stringify(section)}`
      )
    );
  }

  // ---- appendArtifactContent(): 既存内容を壊さない(絶対条件Section9) ----

  results.push(
    check(
      "[Append1] 既存contentが空 -> 新セクションがそのまま本文になる",
      appendArtifactContent("", "## 初回調査\n\n本文") === "## 初回調査\n\n本文"
    )
  );

  {
    const existing = "## 初回調査\n\n最初の調査結果";
    const appended = appendArtifactContent(existing, "## 追加事例\n\n他大学の事例");

    results.push(
      check(
        "[Append2] 既存contentが保持されたまま、新セクションが末尾に追記される",
        appended.includes("## 初回調査") &&
          appended.includes("最初の調査結果") &&
          appended.includes("## 追加事例") &&
          appended.includes("他大学の事例") &&
          appended.indexOf("## 初回調査") < appended.indexOf("## 追加事例"),
        `appended=${JSON.stringify(appended)}`
      )
    );
  }

  // ---- buildArtifactMutationConfirmation(): Conversation側の簡潔な確認文 ----

  {
    // Phase77-A: topicはderiveArtifactTitle()経由のため「について調査
    // して」という命令文の語尾は含まれない(Section2)。
    const confirmation = buildArtifactMutationConfirmation("中京大学のスポーツ系ゼミについて調査して", true);
    results.push(
      check(
        "[Confirm1] 新規Artifact作成時 -> 「整理しました」という文言、命令文を含まないtopic",
        confirmation.includes("整理しました") &&
          confirmation.includes("中京大学のスポーツ系ゼミ") &&
          !confirmation.includes("調査して"),
        `confirmation=${JSON.stringify(confirmation)}`
      )
    );

    results.push(
      check(
        "[Confirm1-Bad回避] 確認文自体はResearchの詳細本文を含まない(短い)",
        confirmation.length < 100,
        `length=${confirmation.length}`
      )
    );
  }

  {
    const confirmation = buildArtifactMutationConfirmation("他大学の事例も追加して", false);
    results.push(
      check(
        "[Confirm2] 既存Artifact更新時 -> 「反映しました」という文言",
        confirmation.includes("反映しました"),
        `confirmation=${JSON.stringify(confirmation)}`
      )
    );
  }

  // ---- core/tact-artifact/store.ts: row↔domain変換(純粋関数) ----

  {
    const row: ArtifactRow = {
      id: "art-1",
      user_id: "user-1",
      project_id: "proj-1",
      work_id: "work-1",
      title: "中京大学のスポーツ系ゼミ調査",
      content: "## 概要\n\n本文",
      blocks: null,
      version: 3,
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T00:05:00.000Z",
    };

    const artifact = toArtifact(row);

    results.push(
      check(
        "[ArtifactRow1] toArtifact(): snake_case -> camelCaseへ正しく変換される",
        artifact.id === "art-1" &&
          artifact.userId === "user-1" &&
          artifact.projectId === "proj-1" &&
          artifact.workId === "work-1" &&
          artifact.version === 3
      )
    );

    const summary = toArtifactSummary(row);

    results.push(
      check(
        "[ArtifactRow2] toArtifactSummary(): id/title/version/updatedAtを持ち、contentを含まない",
        summary.id === "art-1" &&
          summary.title === row.title &&
          summary.version === 3 &&
          !("content" in summary)
      )
    );
  }

  {
    const row: ArtifactRow = {
      id: "art-2",
      user_id: "user-1",
      project_id: null,
      work_id: null,
      title: "未所属Artifact",
      content: "",
      blocks: null,
      version: 1,
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T00:00:00.000Z",
    };

    const artifact = toArtifact(row);

    results.push(
      check(
        "[ArtifactRow3] project_id=null(未所属Artifact) -> projectIdもnull",
        artifact.projectId === null
      )
    );
  }

  return summarize("tact-artifact mutation architecture (Phase 75)", results);

}
