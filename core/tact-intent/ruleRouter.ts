import type { IntentDecision } from "./types";

// =========================
// classifyIntent (STEP216)
// =========================
//
// TACTの新しい入口(components/tact/ResearchSection.tsx)が、入力を
// 3つの既存経路(chat / research / core_push)のどこへ渡すかを判定する
// 純粋関数。LLMは一切使わない(STEP216絶対条件: Rule Routerのコストは
// 常にゼロ)。core/agents・core/planner・core/workflow・core/conversation
// のいずれにも依存しない。
//
// 設計方針:
// - 単純なキーワード部分一致(「調べる」という文字列が含まれるかだけを
//   見る等)は使わない。「調べるってどういう意味?」のような、単語への
//   言及であって依頼ではない入力を誤ってresearchと判定してしまうため。
//   そのため「動詞の語幹 + 依頼を表す活用形(て/てほしい/てもらえる等)」
//   の組み合わせでのみ一致させる(辞書形「調べる」単体では一致しない)。
// - 判定順序: core_push → research → chat(既定)。
//   core_pushは「TACT Coreへの書き込み」という最も明確な意図を示す
//   語のため最初に見る。researchはコストを伴う(Search/LLM)ため、
//   はっきりした依頼表現がある場合のみ一致させる。どちらにも一致
//   しない入力はすべてchatへ落ちる(STEP216-I: 曖昧な入力は安全側の
//   chatを既定とする)。

// 「覚え/記憶し/保存し/登録し」+ 依頼を表す活用形の組み合わせ。
// 辞書形("覚える"等)単体には一致しない。
const CORE_PUSH_PATTERN =
  /(覚え|記憶し|保存し|登録し)(て|ておいて|てほしい|てもらえる)/;

// 「調べ/調査/リサーチ」+ 依頼を表す活用形の組み合わせ。
// 「調べるって」のような辞書形+「って」には一致しない
// (「調べ」の直後が「て」ではなく「る」のため)。
const RESEARCH_PATTERN =
  /(調べ|調査し|リサーチし)(て|てほしい|てもらえる|てください)/;

// =========================
// 疑問文・情報要求パターン (Phase 18)
// =========================
//
// Phase 17で確認された問題: 「日本の首相は誰ですか?」のような疑問文は
// 「調べて」等の依頼表現を含まないため、RESEARCH_PATTERNに一致せず
// 既定のchatへ落ちてしまい、外部事実の確認が必要な質問にLLMが
// 学習知識だけで(古い/誤った内容を)自信ありげに回答してしまう
// (Phase16 Reality Testで実測: 「日本の内閣総理大臣は誰ですか?」に
// 対しchatが確認済みに古い人物名を回答)。
//
// 一方で「Xとは何ですか?」「これはどういう意味ですか?」のような
// 定義・説明・意見・指示語ベースの質問はchatに残すべきで、疑問文である
// ことだけを理由に一律researchへ送ってはいけない(Phase18絶対条件:
// 「疑問文なら全部Research」にはしない、Accuracy > Coverage)。
// Phase 18のStep2で30件超のFP/FN検証を行い、以下の4段階判定の
// 組み合わせが既知のFP事例(「調べるってどういう意味?」等)を保ったまま
// Phase17の疑問文誤判定を解消できることを確認した(検証結果は
// Phase18完了報告を参照)。

// 「とは/って」+「何/どういう」、または「どういう意味」を含む場合は
// 定義・語義質問であることが構文上明確なため、常にchat側に残す
// (複合主語かどうかに関わらず最優先で除外)。
const DEFINITION_QUESTION_PATTERN =
  /どういう意味|とは(何|どういう)|って(何|どういう)/;

// 裸の「Xは/が何ですか」のうち、Xが「の」を含む複合名詞句
// (例:「最新のiPhoneモデルは何ですか」)は外部事実の確認を求める
// 疑問文として扱う。単一の裸名詞・指示語(「コードは何ですか」
// 「これは何ですか」)は定義質問との判別が構造上難しいため対象にしない
// (BARE_WHAT_QUESTION_PATTERNで別途除外する)。
const COMPOUND_WHAT_QUESTION_PATTERN =
  /の.*?(は|が)何(ですか|でしょうか)/;

// 複合構造でない裸の「Xは/が/も何ですか」。COMPOUND_WHAT_QUESTION_PATTERNで
// 拾われなかった場合にのみ判定し、常にchat側へ残す。
const BARE_WHAT_QUESTION_PATTERN =
  /(?:^|[はがも])何(?:です|でしょう)/;

// 具体的な疑問詞(誰/いくら/いくつ/どこ/どのくらい)+ 質問の終端表現。
// 「何」は上記の複合/裸判定で個別に扱うためここには含めない。
const SPECIFIC_QUESTION_WORD_PATTERN =
  /(誰|いくら|いくつ|どこ|どのくらい)(ですか|でしょうか|ますか)/;

// 「どうなっていますか/どうなっているか」(現状把握)のみを対象にする。
// 「どう思いますか」「どうしたらいいですか」は意見・アドバイス要求で
// あり外部事実の確認ではないため対象にしない。
const STATE_QUESTION_PATTERN = /どうな(って|り)(いる|います)/;

// 「何+助数詞(人/歳/年等)+ですか」。裸の「何ですか」(助数詞なし)は
// BARE_WHAT_QUESTION_PATTERNで除外済みのため、ここでは助数詞が
// 入っているものだけを対象にする。
const COUNTED_WHAT_QUESTION_PATTERN =
  /何(?!です|でしょう)[^\s。、？?]{1,3}(ですか|でしょうか)/;

// 「Xについて教えて/知りたい」。ambiguityDetector.tsのVAGUE_SUBJECT_
// QUESTIONS(「競合について」等、対象語が先行文脈依存のカテゴリ語のみ)
// とは独立した判定であり、ここでは対象語の中身を問わない
// (対象語が曖昧かどうかはCommander側のdetectAmbiguity()が別途判定する、
// 絶対条件: Ambiguity Detectionの責務を侵食しない)。
const INFO_REQUEST_PATTERN = /について(教えて|知りたい)/;

// =========================
// 具体的な実例の列挙要求 (Phase82-C)
// =========================
//
// Repository Evidence(Phase81投資調査): 「具体例を5件追加して」
// 「実際の事例を追加して」のような依頼は、「調べ/調査し/リサーチし」
// という動詞語幹を含まないため既定のchatへ落ち、Research Capability
// (実Web検索)を経由しない。しかしこれらは実質的に「外部世界に実在
// する対象物を列挙してほしい」という、事実確認を要する依頼であり、
// chat Handler(検索を一切行わない、事実の深入りを避けるよう指示
// された単発LLM呼び出し)では正確な回答を保証できない。
//
// 絶対条件(Phase82 Principle: False Positiveを極力増やさない):
// トピック(具体例/実例/事例)とアクション(追加して/教えて/挙げて/
// 紹介して)の両方が揃った場合のみ一致させる、狭いポジティブリスト
// のみで構成する。「自分の文章から具体例を5つ作って」のような生成
// 依頼は、アクション語尾が「作って」でありこのリストに含まれない
// ため自然に対象外になる(否定リストを別途作らない、既存
// TOPIC_ACTION_MATCHERS(core/tact-conversation/artifactMutation.ts)
// と同じ「〜して」という依頼活用形のみに限定する設計を踏襲)。
//
// 意図的にスコープ外とした例(Deferred Decision): 「イベントを5件
// 教えて」のような、具体例/実例/事例という語彙を伴わない汎用名詞
// (イベント/企業/商品等)+教えてのパターンはここでは拾わない
// (対象語彙を無制限に広げるとFalse Positiveの制御が難しくなるため、
// 今回は明確に「具体例」を求める語彙があるものだけに限定する)。
const CONCRETE_EXAMPLE_TOPIC_PATTERN = /(具体例|実例|事例)/;
const CONCRETE_EXAMPLE_ACTION_PATTERN = /(追加して|教えて|挙げて|紹介して)/;

function looksLikeConcreteExampleRequest(trimmed: string): boolean {

  return (
    CONCRETE_EXAMPLE_TOPIC_PATTERN.test(trimmed) &&
    CONCRETE_EXAMPLE_ACTION_PATTERN.test(trimmed)
  );

}

// =========================
// 追加Research要求の判定 (Phase86)
// =========================
//
// Root Cause(Phase85投資調査): 「大学3〜4年生が実際に参加しやすそう
// なものを5件ほど追加で確認してください」のような、既存Research文脈
// を引き継いだ追加調査要求が、「調べ/調査し/リサーチし」という動詞
// 語幹を含まないためchatへ落ちていた(isArtifactReferenceQuestion()
// 側の誤判定はPhase85で別途修正済み。本PhaseはclassifyIntent()側)。
//
// 絶対条件(Section2「Research Intentを単純に広げすぎない」): 「教えて」
// 「確認」「おすすめ」等の一般語単体では一致させない。「追加で/さらに/
// 他にも/別の」という明確な追加要求マーカーと、調査系アクション動詞
// (調べ/確認し/探し)が近接して現れる場合のみを対象にする。マーカーと
// 動詞の間には「5件」「3件ほど」等の件数表現が挟まることを許容するが
// (最大15文字)、句読点(。、)をまたぐ遠い箇所には反応しない
// (Phase79のCOMPARISON_TRIGGER_PATTERN・parseComparisonColumns()と
// 同じ「節スコープに近い限定」の考え方を踏襲)。
const ADDITIONAL_RESEARCH_PATTERN =
  /(?:追加で|さらに|他にも|別の)[^。、]{0,15}?(?:調べ|確認し|探し)(?:て|てください|てほしい|てもらえる)/;

// Phase88: core/tact-orchestrator/decomposer.tsが「今回のTurnが直前
// Turnの主題を引き継ぐべき追加調査要求かどうか」を判定するために、
// classifyIntent()内部の判定ロジックをそのまま再利用できるよう公開
// する(新しい判定ロジックを二重に持たない、既存関数のexportのみ)。
export function looksLikeAdditionalResearchRequest(trimmed: string): boolean {
  return ADDITIONAL_RESEARCH_PATTERN.test(trimmed);
}

// =========================
// 直前Researchを引き継ぐ継続要求の判定 (Phase86、Conversation Context利用)
// =========================
//
// 上記の単独判定だけでは拾えない、より緩やかな継続要求(「もう少し
// 事例を増やしてください」「別のイベントも見つけてください」等)を、
// 直前Turnが実際にResearchだった場合に限り対象へ加える。
// 「見つけて」「増やして」のような汎用動詞は、文脈が無ければ日常会話
// でも自然に使われる(絶対条件: 一般的な会話をResearchにしない)ため、
// 直前TurnがResearchだったという確認済みの事実がある場合のみ許可する
// (Section3「Conversation Contextを利用する」)。
//
// 直前Turnのuser発言(previousInput)は、呼び出し元
// (core/tact-orchestrator/decomposer.ts経由でOrchestrationRequest.
// previousUserInputから)が既存のConversation履歴から渡す——新しい
// Memory/Context Architectureは追加しない(Section9絶対条件)。直前
// Turn自体がResearchだったかどうかは、この関数自身
// (classifyIntent())を再帰的に1回だけ呼んで判定する(新しい判定
// ロジックを二重に持たない、絶対条件「LLM Intent Classificationの
// 追加禁止」とも整合——決定論的な既存関数の再利用のみ)。
const RESEARCH_CONTINUATION_PATTERN =
  /(?:追加|さらに|他にも|別の|もう少し)[^。、]{0,15}?(?:調べ|確認し|探し|見つけ|増やし|挙げ)(?:て|てください|てほしい|てもらえる)/;

// Phase88: 上記looksLikeAdditionalResearchRequest()と同じ理由でexport
// する。core/tact-orchestrator/decomposer.tsが「Task.descriptionへ
// 直前Turnの主題を補完すべきかどうか」の判定に、この関数をそのまま
// 再利用する。
export function looksLikeResearchContinuation(
  trimmed: string,
  previousInput: string | undefined
): boolean {

  if (!previousInput) {
    return false;
  }

  if (classifyIntent(previousInput).intent !== "research") {
    return false;
  }

  return RESEARCH_CONTINUATION_PATTERN.test(trimmed);

}

function looksLikeResearchQuestion(trimmed: string): boolean {

  if (DEFINITION_QUESTION_PATTERN.test(trimmed)) {
    return false;
  }

  if (COMPOUND_WHAT_QUESTION_PATTERN.test(trimmed)) {
    return true;
  }

  if (BARE_WHAT_QUESTION_PATTERN.test(trimmed)) {
    return false;
  }

  return (
    SPECIFIC_QUESTION_WORD_PATTERN.test(trimmed) ||
    STATE_QUESTION_PATTERN.test(trimmed) ||
    COUNTED_WHAT_QUESTION_PATTERN.test(trimmed) ||
    INFO_REQUEST_PATTERN.test(trimmed)
  );

}

export function classifyIntent(input: string, previousInput?: string): IntentDecision {

  const trimmed = input.trim();

  if (!trimmed) {

    // ResearchSection.tsx側で空入力は送信前に弾く既存実装だが、
    // classifyIntent自体を将来他所から呼んでも安全なように、ここでも
    // 明示的にchatへフォールバックする(API呼び出しは発生しない)。
    return { intent: "chat", reason: "empty input" };

  }

  if (CORE_PUSH_PATTERN.test(trimmed)) {

    return {
      intent: "core_push",
      // STEP216スコープ外の自動分類(knowledge/memory/exampleの
      // 精密な判別)は行わない。「覚えて」系の表現はCoreMemoryの
      // 定義(好み・ルール・文脈等の記憶)に最も近いため、Rule Router
      // からの既定typeは"memory"に固定する。
      corePushType: "memory",
      reason: "matched core_push pattern (覚え/記憶/保存/登録 + 依頼表現)",
    };

  }

  if (RESEARCH_PATTERN.test(trimmed)) {

    return {
      intent: "research",
      reason: "matched research pattern (調べ/調査/リサーチ + 依頼表現)",
    };

  }

  // Phase82-C: 「具体例を5件追加して」等、外部世界に実在する対象物の
  // 列挙を求める依頼(調べ/調査/リサーチという動詞語幹を含まない)。
  if (looksLikeConcreteExampleRequest(trimmed)) {

    return {
      intent: "research",
      reason: "matched concrete example request pattern (具体例/実例/事例 + 追加して/教えて等)",
    };

  }

  // Phase86: 「追加で5件確認してください」等、単独でも明確な追加調査
  // 要求と判定できるもの(Conversation Contextを必要としない)。
  if (looksLikeAdditionalResearchRequest(trimmed)) {

    return {
      intent: "research",
      reason: "matched additional research request pattern (追加で/さらに/他にも/別の + 調べ/確認し/探し)",
    };

  }

  // Phase86: 「もう少し事例を増やしてください」等、直前TurnがResearch
  // だった場合に限りResearchの継続要求として扱う(Conversation
  // Contextを利用、Section3)。
  if (looksLikeResearchContinuation(trimmed, previousInput)) {

    return {
      intent: "research",
      reason: "matched research continuation pattern (直前Turnがresearchだった場合の継続要求)",
    };

  }

  // Phase 18: 「調べて」等の依頼表現を含まない疑問文・情報要求
  // (「日本の首相は誰ですか?」「トヨタについて教えて」等)を拾う。
  // 定義・説明・意見・指示語ベースの質問(「Xとは何ですか?」
  // 「これはどういう意味ですか?」等)はlooksLikeResearchQuestion内で
  // 除外されるため、ここに到達してtrueになるのは外部事実の確認を
  // 求める疑問文・情報要求のみ。
  if (looksLikeResearchQuestion(trimmed)) {

    return {
      intent: "research",
      reason: "matched research question pattern (疑問詞/について+教えて等)",
    };

  }

  return {
    intent: "chat",
    reason: "no research/core_push pattern matched (default to chat)",
  };

}
