import type { Artifact, EvidenceBlock, FindingBlock, RecommendationBlock } from "../tact-artifact/types";

// =========================
// TACT Conversation — Artifact Reference Answering (Phase 77 Section5)
// =========================
//
// Repository Evidence(Phase77 investigation): 「今の調査で一番重要な
// のは?」のような質問は、既存実装ではclassifyArtifactMutation()が
// null(=Case A/B、Artifact更新対象外)を返すため、
// core/tact-conversation/orchestration.tsのapplyArtifactMutation()は
// plan.answerをそのまま返していた。plan.answerはcore/tact-orchestrator/
// executor.tsのrunChat()(core/tact-intent/chatHandler.ts)が生成した
// 値であり、Chat HandlerはtaskContext.coreContext(Core側の
// Knowledge/Memory/Example)しか参照できず、Conversationが育てている
// Artifact(Finding/Evidence/Recommendation等)を一切知らない
// (OrchestrationRequest/TaskContextにArtifactを渡す経路自体が
// 存在しない)。そのため「一般的には信頼性・具体性・関連性が重要です」
// のような、Artifactを一切参照しない一般論が返っていた
// (Section5で指摘された問題そのもの)。
//
// 修正方針(絶対条件: 新しいLLM呼び出しを追加しない、Workflow Engine
// (core/tact-orchestrator/*)の設計を変更しない):
// OrchestrationRequestへArtifactを渡す経路を新設する(core/tact-
// orchestrator配下の変更、Workflow全体の設計変更)は行わない。
// 代わりに、Conversation Layer側(このファイル)で「Artifactを参照
// すべき質問かどうか」を決定論的に判定し、該当する場合は
// Orchestrator/LLMの出力(plan.answer)を使わず、現在のArtifact
// (Finding/Evidence/Recommendation Block)から直接、決定論的に
// 回答文を組み立てる。新しいLLM呼び出しは一切発生しない
// (Orchestrator自体は今まで通り1回だけ呼ばれるが、その出力を
// この判定に該当する場合だけ差し替える)。
//
// 絶対条件(Section5): Artifact自体を変更する必要がない質問では
// Artifact Mutationを発生させない。この判定はclassifyArtifactMutation()
// が既にnullを返しているケースにのみ適用される(呼び出し元
// orchestration.tsのapplyArtifactMutation()、kind===nullの分岐内)ため、
// この関数自体もArtifactの読み取りのみを行い、書き込みは一切行わない。

// =========================
// isArtifactReferenceQuestion
// =========================
//
// 「今の調査/成果物にとって重要なことは何か」を尋ねている入力かを、
// 既存のdetectArtifactMutationIntent()/classifyArtifactMutation()と
// 同じ「決定論的なkeyword-based heuristic」(Section16絶対条件)で
// 判定する。トピック語彙(「重要」「ポイント」「結論」「論点」)を
// 含み、かつMutation指示(EXPLICIT_MUTATION_PHRASESに相当する「〜して」
// 系の指示形)ではない入力を対象にする——呼び出し元がclassify()===null
// (Mutation対象外と既に判定済み)の場合のみこの関数を呼ぶ設計のため、
// ここでは「〜して」系の指示形かどうかを再判定しない。
const REFERENCE_TOPIC_WORDS = [
  "一番重要",
  "重要なのは",
  "重要なポイント",
  "何が重要",
  "重要な点",
  "ポイントは",
  "結局",
  "結論",
  "論点",
  "要点",
  "まとめると",
  // Phase77再実装(Section10)で追加: 「この調査から何が言える?」
  // 「どの施策を優先すべき?」等、既存語彙(重要/結局/結論等)に
  // 一致しない典型的なArtifact参照質問の言い回し。
  "何が言える",
  "何がわかった",
  "何が分かった",
  "優先",
  // Phase85追加: 「さっきの結果の中でおすすめはどれ?」「前に調べた
  // 内容からおすすめを教えて」のような、既存Artifactへの言及に
  // 一般的な語彙。
  "おすすめ",
];

// Phase85(Repository Evidence: Phase84投資調査): 「5件ほど追加で
// 確認してください。確認できるものを優先してください。」のような、
// 新しい調査・追加情報を要求する入力に「優先」等のREFERENCE_TOPIC_WORDS
// が偶然含まれるだけで、既存Artifactを参照する質問として誤判定されて
// いた(実Reality Testで実際に発生し、新規Researchが一切実行されない
// 不具合の直接原因になっていたことをDB実データで確認済み)。
//
// 修正: 「追加で」「新たに」「さらに調べ」「確認してください」
// 「調べてください」「調査してください」という、新しい調査・確認
// アクションを明示的に要求する語がメッセージ内に存在する場合は、
// REFERENCE_TOPIC_WORDSが一致していてもArtifact Reference Questionとは
// 扱わない(Section2「既存Artifactを参照して答えを求めているのか、
// 新しい調査・追加情報を要求しているのか」を区別する)。
//
// 既存のtrue判定ケース(Phase77 RefE1「今の調査で一番重要なのは?」等)
// はいずれもこれらの新規調査アクション語を含まないため、この除外は
// 既存挙動に影響しない(回帰テストで確認)。
const NEW_RESEARCH_ACTION_PATTERN =
  /追加で|新たに|さらに調べ|確認してください|調べてください|調査してください/;

export function isArtifactReferenceQuestion(userInput: string): boolean {

  const hasReferenceTopic = REFERENCE_TOPIC_WORDS.some((word) => userInput.includes(word));

  if (!hasReferenceTopic) {
    return false;
  }

  // Phase85優先順位: 新しい調査アクションの要求が明示されている場合、
  // Reference Topic語が偶然含まれていてもArtifact参照質問として
  // 扱わない(新規調査を優先する)。
  if (NEW_RESEARCH_ACTION_PATTERN.test(userInput)) {
    return false;
  }

  return true;

}

// =========================
// buildArtifactReferenceAnswer
// =========================
//
// Finding/Evidence/Recommendation Blockから、その調査固有の要点を
// 決定論的に組み立てる(新しい要約・言い換えLLM呼び出しは行わない、
// 既存Block本文をそのまま引用するだけ)。Section5の例文
// (「今回の調査で最も重要なのは〜です。現在の成果物では『〜』
// 『〜』が主要な論点として整理されています。特に〜という
// Evidenceがこの論点を支えています。」)と同じ構成——Finding→
// Evidence→(あれば)Recommendationの順に、実際にArtifactへ
// 保存されている内容だけを引用する。
//
// Artifactにこれらのblockが1件も無い場合(調査がまだ行われていない、
// または雑談だけのArtifact)はnullを返す——呼び出し元はplan.answer
// (既存のchat応答)へフォールバックする(一般論を強制的に消すより、
// 「参照できる調査内容が無い」という事実を隠さない方が安全、
// Section5「Artifactを参照する」という前提そのものが満たせない
// ケースの安全側処理)。
const FINDING_QUOTE_MAX_LENGTH = 60;
const CLAIM_QUOTE_MAX_LENGTH = 60;
const MAX_QUOTED_FINDINGS = 3;

function truncateForQuote(text: string, maxLength: number): string {

  const trimmed = text.trim();

  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength)}...`
    : trimmed;

}

export function buildArtifactReferenceAnswer(artifact: Artifact): string | null {

  const findings = artifact.blocks.filter(
    (b): b is FindingBlock => b.type === "finding"
  );

  const evidence = artifact.blocks.filter(
    (b): b is EvidenceBlock => b.type === "evidence"
  );

  const recommendations = artifact.blocks.filter(
    (b): b is RecommendationBlock => b.type === "recommendation"
  );

  if (findings.length === 0 && evidence.length === 0 && recommendations.length === 0) {
    return null;
  }

  const parts: string[] = [];

  if (findings.length > 0) {

    const quoted = findings
      .slice(0, MAX_QUOTED_FINDINGS)
      .map((f) => `「${truncateForQuote(f.content, FINDING_QUOTE_MAX_LENGTH)}」`)
      .join("、");

    parts.push(
      `「${artifact.title}」で現在重要と整理されているのは ${quoted} です。`
    );

  }

  if (evidence.length > 0) {

    const top = evidence[0];
    const sourceNote = top.source ? `(出典: ${top.source})` : "";

    parts.push(
      `特に「${truncateForQuote(top.claim, CLAIM_QUOTE_MAX_LENGTH)}」という根拠${sourceNote}がこの論点を支えています。`
    );

  }

  if (recommendations.length > 0) {

    parts.push(
      `ここまでの内容を踏まえた施策として「${truncateForQuote(recommendations[0].content, CLAIM_QUOTE_MAX_LENGTH)}」を成果物に整理しています。`
    );

  }

  return parts.join("\n");

}
