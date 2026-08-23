import { classifyIntent } from "../tact-intent/ruleRouter";
import type { OrchestrationRequest } from "./types";
import type { Task } from "./task";

// =========================
// decomposeTask (Phase 3、Phase 10で比較表現の自然言語耐性を追加)
// =========================
//
// Commander本体(commander.ts)から分離した、独立した責務(STEP絶対条件:
// 「分解ロジックは将来LLM-based Dynamic Decompositionへ差し替えられる
// よう、Commander本体と分離する」)。Phase 3では自律的なLLMベースの
// Task分解を行わず、ルールベースの最小Decomposerとする。Phase 10でも
// この方針は維持し、LLM/Embeddingは追加しない。
//
// 判定の優先順位:
//   1. 比較パターン(独立した複数調査 → 並列実行可能): "AについてX、
//      Bと比較して" のような、2つの独立した対象を持つ入力を2つの
//      researchタスクへ分解する。両者に依存関係は無い(Aggregatorが
//      比較そのものを行う、Task自体を「比較する」責務にはしない)。
//   2. 並列表現による比較パターン(Phase 10): "AとBをそれぞれ調べて
//      比較して"のような、比較対象2つを"AとB"という並列表現でまとめて
//      提示し、個別調査を明示的に要求する表現。上記1のパターンは
//      「Aについて調べ...Bと比較」という対象が2箇所に分かれた構造
//      前提のため、この構造(対象が1箇所にまとまる)には対応できず、
//      Phase 8 Reality Testで実際に取りこぼしが確認された
//      (詳細はLISTED_SUBJECTS_COMPARE_PATTERNのコメント参照)。
//   3. 依存パターン(順序性のある2段階の依頼): "AについてX、その結果
//      をもとにY" のような、後続処理が前段の結果を要求する入力を、
//      dependenciesで結んだ2 Taskへ分解する。
//   4. それ以外はSimple Task(1件)。capability判定はcore/tact-intent/
//      ruleRouter.tsのclassifyIntent()をそのまま再利用する
//      (STEP216で確立済みの「調べるってどういう意味?」等の誤判定
//      対策を含むロジックを重複実装しない)。
//
// 重要な制約(絶対条件8): Sub-agentからSub-agentを生成するnested
// spawnは行わない。decomposeTask()が返すTask[]は常にフラットな
// 1階層の配列であり、実行後に新しいTaskを動的追加する経路は
// executor.ts/commander.tsのどこにも存在しない。

// 独立した2対象の比較: 「A社について調査し、競合3社と比較して」等。
const COMPARE_PATTERN =
  /^(.+?)(?:について|を)(?:調べ|調査)(?:て|し)(?:て)?、?\s*(.+?)と比較/;

// Phase 10: 「AとBをそれぞれ調べて比較して」のような、比較対象2つを
// 「AとB」という並列表現でまとめて提示し、個別調査を明示的に要求する
// 表現を扱う。上のCOMPARE_PATTERNは「Aについて調べ...Bと比較」という
// 2箇所に対象が現れる構造を前提としており、「AとB」を1箇所にまとめて
// 述べる構造(Phase 8 Reality Testで実際に取りこぼしを確認した表現)
// には対応できない。
//
// 絶対条件(Phase 10 Step4): 「それぞれ」等の語が存在するだけで
// 無条件に分解しない。「AとB」という複数対象の並列提示と、
// 「それぞれ/各々/個別に/別々に」という個別調査の明示的要求の
// 両方が揃った場合のみ分解する。個別調査の明示が無い比較依頼
// (例:「AとBを比較して」「AとBについて調査して」)は、対象語を
// 誤って引き剥がして無理に2 Taskへ分解するより、1 Taskとして扱う方が
// 安全(絶対条件18: False PositiveをRecallより優先して避ける)。
//
// 対象抽出の安全性(Step5): 「と」「の」といった助詞・接続語自体を
// 比較対象として抽出しないよう、group1/group2は「について|を|の」の
// 直前までの非貪欲マッチとする(単一文字・助詞だけを対象として誤抽出
// することを構造的に防ぐ。抽出結果が空文字になった場合は分解しない
// 安全策も既存2パターンと同様に維持する)。
const INDIVIDUAL_INVESTIGATION_MARKER = "(?:それぞれ|各々|個別に|別々に)";

const LISTED_SUBJECTS_COMPARE_PATTERN = new RegExp(
  "^(.+?)と(.+?)(?:について|を|の).*?" +
  INDIVIDUAL_INVESTIGATION_MARKER +
  ".*?(?:調べ|調査).*?比較"
);

// 逐次依存: 「Aについて調べて、その結果をもとに要約してください」等。
// 長い接続表現を先に置き、短い「その結果」だけの表現より優先して
// 消費させる(JS正規表現の交代は左から順に試行されるため)。
const SEQUENTIAL_PATTERN =
  /^(.+?)(?:について|を)(?:調べ|調査)(?:て|し)(?:て)?、?(?:その結果をもとに|その結果を踏まえて|それをもとに|それを踏まえて|を踏まえて|その結果)、?(.+?)(?:して)?(?:ください)?。?$/;

function makeTask(
  description: string,
  assignedCapability?: string,
  dependencies?: string[]
): Task {

  return {

    id: crypto.randomUUID(),

    description,

    status: "pending",

    assignedCapability,

    dependencies,

  };

}

export function decomposeTask(
  request: OrchestrationRequest
): Task[] {

  const input = request.input.trim();

  const compareMatch = input.match(COMPARE_PATTERN);

  if (compareMatch) {

    const subjectA = compareMatch[1].trim();
    const subjectB = compareMatch[2].trim();

    if (subjectA && subjectB) {

      return [
        makeTask(`${subjectA}について調査する`, "research"),
        makeTask(`${subjectB}について調査する`, "research"),
      ];

    }

  }

  const listedSubjectsCompareMatch = input.match(
    LISTED_SUBJECTS_COMPARE_PATTERN
  );

  if (listedSubjectsCompareMatch) {

    const subjectA = listedSubjectsCompareMatch[1].trim();
    const subjectB = listedSubjectsCompareMatch[2].trim();

    // 対象抽出の安全性(Step5): 助詞・単一文字・空文字を対象として
    // 扱わない。既存2パターンと同じ最小限のガード。
    if (subjectA && subjectB) {

      return [
        makeTask(`${subjectA}について調査する`, "research"),
        makeTask(`${subjectB}について調査する`, "research"),
      ];

    }

  }

  const sequentialMatch = input.match(SEQUENTIAL_PATTERN);

  if (sequentialMatch) {

    const subject = sequentialMatch[1].trim();
    const followUpAction = sequentialMatch[2].trim();

    if (subject && followUpAction) {

      const researchTask = makeTask(`${subject}について調査する`, "research");

      const followUpTask = makeTask(
        `調査結果をもとに${followUpAction}する`,
        undefined,
        [researchTask.id]
      );

      return [researchTask, followUpTask];

    }

  }

  // Simple Task: 1件。capability判定はIntent Router(STEP216)の
  // classifyIntent()を再利用する。core_pushはPhase 3のOrchestrator
  // ではCapability Registry未登録(core/tact-bootstrap.tsが登録
  // 済みなのはresearch/designのみ)のため、chatと同じ既定経路
  // (assignedCapability未指定 → executor.tsがChat Handlerへ
  // フォールバック)として扱う。TACT CoreへのPush判断をOrchestrator
  // が自律的に行うことはPhase 3のスコープ外。
  const decision = classifyIntent(input);

  const assignedCapability =
    decision.intent === "research" ? "research" : undefined;

  return [makeTask(input, assignedCapability)];

}
