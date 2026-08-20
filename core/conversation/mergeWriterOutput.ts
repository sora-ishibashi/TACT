// =========================
// reconcileCurrentOutput (STEP16-A)
// =========================
//
// 背景:
// 継続Conversationにおいて、Writerがprompt指示(currentOutputSection・
// STEP12-Bの編集指示リマインダー)に反し、既存の全章ではなく一部の
// sectionsのみを返すケースが実機ログで確認された
// (例: 既存4章のうち1章のみを含むJSONを返す)。
//
// これまでcore/conversation/index.tsは
//   conversation.currentOutput = context.outputs.writer ?? conversation.currentOutput
// という単純代入のみを行っており、Writerの出力を無条件に信頼していた。
//
// 本モジュールは、Workflow/Agent(Writerのprompt含む)には一切手を
// 加えず、Conversation層でWriterの出力を受け取った直後にのみ介入し、
// 既存章を不用意に失わないようにする安全網を提供する。
//
// 重要: ユーザー入力テキストの文字列検索(例: task.includes("全部"))
// のような脆い判定は行わない。Task Reconstructionが生成するeditIntent
// はConversation層まで伝播していないため(reconstructCurrentTask()の
// 戻り値は合成済みcurrentTask文字列のみ)、これにも依存しない。
// 代わりに、Writerが実際に返したsectionsの見出しと、旧currentOutputの
// 見出しとの構造的な重なりのみを判定材料とする。

// =========================
// 型
// =========================
//
// Writer出力には正式なTypeScript型定義が存在しないため
// (outputFormats.tsはプロンプト用の文字列テンプレートのみ)、
// ここでは検証に必要な最小限の形をローカルに定義する。
// anyは使用しない。

interface WriterSection {
  heading: string;
  [key: string]: unknown;
}

interface WriterOutputShape {
  sections: WriterSection[];
  [key: string]: unknown;
}

function isValidWriterOutput(
  value: unknown
): value is WriterOutputShape {

  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate.sections)) {
    return false;
  }

  return candidate.sections.every(
    (section) =>
      section !== null &&
      typeof section === "object" &&
      typeof (section as Record<string, unknown>).heading === "string"
  );

}

// 見出しの正規化。
// 「1. 」「2) 」のような先頭の番号プレフィックスと前後の空白のみを
// 取り除く。それ以外の曖昧な類似度判定・部分一致は行わない
// (誤って別章を同一章と判定することの方が危険なため)。
//
// STEP17: Task Reconstructionが返すpreserveHeadingsとの照合、および
// UI側の変更箇所ハイライトでの見出し比較にも同じ正規化基準を使うため
// exportする。
//
// STEP22: Writerが見出しを「1. 見出し」ではなく「第1章: 見出し」形式で
// 返すことがあり(全面書き直し後などで発生することを実機テストで確認)、
// 従来の数字プレフィックスのみの除去では「第1章: 見出し」が除去されず、
// Task Reconstructionが返すtarget(プレフィックスなしの見出し)と
// 一致しなくなる不具合があった。これにより、preserveHeadingsの
// 対象章除外が機能せず、対象章自身がreconcileCurrentOutput()の
// 保護対象に誤って含まれ、Writerによる正当な更新が巻き戻される
// ケースが確認されたため、「第N章:」系のプレフィックスも
// 併せて除去する。
export function normalizeHeading(heading: string): string {

  return heading
    .trim()
    .replace(/^第[0-9０-９]+章[:：]?\s*/, "")
    .replace(/^[0-9０-９]+[.)、）.．]\s*/, "")
    .trim();

}

// =========================
// reconcileCurrentOutput
// =========================
//
// previousOutput: 更新前のconversation.currentOutput
// newOutput: 今回のWriterの出力(context.outputs.writer)
//
// 戻り値は、既存の`context.outputs.writer ?? conversation.currentOutput`
// という代入式の右辺として扱われることを前提にする
// (呼び出し元でnewOutputがfalsyの場合はそもそもこの関数を呼ばない)。
//
// STEP17: 第3引数optionsを追加。
// Task Reconstructionが「今回維持すべき章」として特定できた場合、
// isFullRewriteがfalseである限り、それらの章はWriterがどう出力しても
// 旧内容へ機械的に戻す(promptでの指示遵守だけに頼らない安全網)。
// optionsを渡さない既存呼び出しは、従来どおり保護なしで動作する
// (挙動を変えない)。

export interface ReconcileOptions {
  // Task Reconstructionから伝播した、今回変更してはいけない章見出し。
  preserveHeadings?: string[];
  // ユーザーが「全体を書き直して」等、明確に全面更新を求めている場合はtrue。
  // trueの場合、preserveHeadingsによる保護は適用しない。
  isFullRewrite?: boolean;
}

export function reconcileCurrentOutput(
  previousOutput: unknown,
  newOutput: unknown,
  options?: ReconcileOptions
): unknown {

  // 新規Conversation、または旧成果物が期待する構造でない場合は
  // マージ対象がないため、Writerの新出力をそのまま採用する。
  if (!isValidWriterOutput(previousOutput)) {
    return newOutput;
  }

  // Writerの新出力が期待する構造でない場合は、安全側として
  // 何も加工せずそのまま返す
  // (呼び出し元の既存fallback = 「truthyならそのまま採用」という
  // 従来挙動を壊さないため)。
  if (!isValidWriterOutput(newOutput)) {
    return newOutput;
  }

  const oldSections = previousOutput.sections;
  const newSections = newOutput.sections;

  // Writerが明らかな異常出力(空配列)を返した場合、
  // 旧に章が存在するなら旧成果物をそのまま維持する。
  if (
    newSections.length === 0 &&
    oldSections.length > 0
  ) {
    return previousOutput;
  }

  const normalizedOld =
    oldSections.map((section) =>
      normalizeHeading(section.heading)
    );

  const normalizedNew =
    newSections.map((section) =>
      normalizeHeading(section.heading)
    );

  const matchCount =
    normalizedOld.filter((heading) =>
      normalizedNew.includes(heading)
    ).length;

  let result: WriterOutputShape;

  // Writerが返した章が、旧のどの章の見出しとも一致しない場合は
  // 全面的な作り直しとみなし、そのまま採用する(旧章を補完しない)。
  if (matchCount === 0) {

    result = newOutput;

  // 旧のすべての章がWriterの新出力でカバーされている場合は、
  // Writerの出力をそのまま採用する(二重化・重複を避ける)。
  } else if (matchCount === oldSections.length) {

    result = newOutput;

  } else {

    // ここから部分更新:
    // 旧の章順を維持しつつ、対応する新sectionがあれば差し替え、
    // なければ旧のまま維持する。
    const usedNewIndices = new Set<number>();

    const mergedSections = oldSections.map(
      (oldSection, index) => {

        const normalizedOldHeading =
          normalizedOld[index];

        const matchIndex =
          newSections.findIndex(
            (newSection, newIndex) =>
              !usedNewIndices.has(newIndex) &&
              normalizeHeading(newSection.heading) ===
                normalizedOldHeading
          );

        if (matchIndex !== -1) {
          usedNewIndices.add(matchIndex);
          return newSections[matchIndex];
        }

        return oldSection;

      }
    );

    // Writerが返したが旧のどの章にも対応しなかったsectionは、
    // 新しい章の追加とみなして末尾に加える。
    newSections.forEach((newSection, index) => {

      if (!usedNewIndices.has(index)) {
        mergedSections.push(newSection);
      }

    });

    result = {
      ...newOutput,
      sections: mergedSections,
    };

  }

  // STEP17: 対象外章の保護(機械的な最終ガード)。
  // 部分更新かどうか(上のどの分岐を通ったか)に関わらず、
  // 「維持すべき」と分かっている見出しにマッチするsectionは、
  // 最終的に旧内容へ戻す。全面書き直し(isFullRewrite)の場合は
  // 適用しない。
  if (
    !options?.isFullRewrite &&
    options?.preserveHeadings &&
    options.preserveHeadings.length > 0
  ) {

    const protectedHeadings = new Set(
      options.preserveHeadings.map(normalizeHeading)
    );

    const oldByHeading = new Map<string, WriterSection>();

    oldSections.forEach((section, index) => {
      oldByHeading.set(normalizedOld[index], section);
    });

    result = {
      ...result,
      sections: result.sections.map((section) => {

        const normalizedHeading =
          normalizeHeading(section.heading);

        if (!protectedHeadings.has(normalizedHeading)) {
          return section;
        }

        return (
          oldByHeading.get(normalizedHeading) ?? section
        );

      }),
    };

  }

  return result;

}

// =========================
// buildAssistantMessage (STEP16-B)
// =========================
//
// 「更新前のcurrentOutput」と「reconcileCurrentOutput()を通過した
// 最終的なcurrentOutput」を比較し、実際に確認できた変更内容だけを
// 短い日本語で説明する。LLM呼び出しは一切行わない。
//
// 重要: 呼び出し元は必ず、Writerの生出力ではなく
// reconcileCurrentOutput()の戻り値(マージ後の最終成果物)を
// newOutputとして渡すこと。Writerが一部の章しか返さなかった場合でも、
// マージ後は他の章が復元されているため、実際にユーザーへ伝えるべき
// 変更点は「マージ後の最終差分」でなければならない。
//
// 確認できない・断定できない変更内容は生成しない。判定できない場合は
// 常に固定文言へfallbackする。

const FALLBACK_UPDATED = "成果物を更新しました。";
const FALLBACK_CREATED = "成果物を作成しました。";

// 一度に列挙する変更点の上限。これを超える場合は、個々の章名を
// 羅列した不自然に長いメッセージになるため、安全側にfallbackする。
const MAX_LISTED_CHANGES = 5;

// =========================
// diffSections (STEP17)
// =========================
//
// buildAssistantMessage()が内部で行っていた新旧section比較を、
// UI側の変更箇所ハイライト(FinalOutput.tsx)からも再利用できるよう
// 独立した関数として切り出したもの。ロジック自体はSTEP16-Bから
// 変更していない。previousOutput/newOutputが期待する構造でない場合は
// 空の差分を返す(呼び出し元が安全に扱えるようにするため)。

export interface SectionDiff {
  changedHeadings: string[];
  addedHeadings: string[];
  removedHeadings: string[];
}

export function diffSections(
  previousOutput: unknown,
  newOutput: unknown
): SectionDiff {

  if (
    !isValidWriterOutput(previousOutput) ||
    !isValidWriterOutput(newOutput)
  ) {

    return {
      changedHeadings: [],
      addedHeadings: [],
      removedHeadings: [],
    };

  }

  const oldSections = previousOutput.sections;
  const newSections = newOutput.sections;

  const normalizedOld =
    oldSections.map((section) =>
      normalizeHeading(section.heading)
    );

  const changedHeadings: string[] = [];
  const addedHeadings: string[] = [];
  const removedHeadings: string[] = [];

  const matchedNewIndices = new Set<number>();

  oldSections.forEach((oldSection, index) => {

    const normalizedOldHeading = normalizedOld[index];

    const matchIndex = newSections.findIndex(
      (newSection, newIndex) =>
        !matchedNewIndices.has(newIndex) &&
        normalizeHeading(newSection.heading) ===
          normalizedOldHeading
    );

    if (matchIndex === -1) {
      removedHeadings.push(oldSection.heading);
      return;
    }

    matchedNewIndices.add(matchIndex);

    const newSection = newSections[matchIndex];

    const oldContent =
      typeof oldSection.content === "string"
        ? oldSection.content
        : undefined;

    const newContent =
      typeof newSection.content === "string"
        ? newSection.content
        : undefined;

    // contentが両方とも文字列として比較できる場合のみ、
    // 実際に変化したかどうかを判定する。
    // どちらかがcontentを持たない等、安全に比較できない場合は
    // 「変更した」と断定せず、変更なし扱いのままにする。
    if (
      oldContent !== undefined &&
      newContent !== undefined &&
      oldContent !== newContent
    ) {
      changedHeadings.push(newSection.heading);
    }

  });

  newSections.forEach((newSection, index) => {

    if (!matchedNewIndices.has(index)) {
      addedHeadings.push(newSection.heading);
    }

  });

  return { changedHeadings, addedHeadings, removedHeadings };

}

export function buildAssistantMessage(
  previousOutput: unknown,
  newOutput: unknown
): string {

  // 新規Conversation(旧成果物がまだ存在しない)。
  if (!isValidWriterOutput(previousOutput)) {

    return isValidWriterOutput(newOutput)
      ? FALLBACK_CREATED
      : FALLBACK_UPDATED;

  }

  // 新成果物の構造が期待通りでない場合は、内容を断定できないため
  // 安全側にfallbackする。
  if (!isValidWriterOutput(newOutput)) {
    return FALLBACK_UPDATED;
  }

  const { changedHeadings, addedHeadings, removedHeadings } =
    diffSections(previousOutput, newOutput);

  const totalChanges =
    changedHeadings.length +
    addedHeadings.length +
    removedHeadings.length;

  // 何も実質的な変更を確認できなかった場合。
  if (totalChanges === 0) {
    return FALLBACK_UPDATED;
  }

  // 変更点が多すぎる場合、個々を列挙すると不自然になるため
  // 安全側にfallbackする。
  if (totalChanges > MAX_LISTED_CHANGES) {
    return FALLBACK_UPDATED;
  }

  const parts: string[] = [];

  if (changedHeadings.length > 0) {

    parts.push(
      changedHeadings
        .map((heading) => `「${heading}」`)
        .join("と") +
      "を更新しました"
    );

  }

  if (addedHeadings.length > 0) {

    parts.push(
      addedHeadings
        .map((heading) => `「${heading}」`)
        .join("と") +
      "を追加しました"
    );

  }

  if (removedHeadings.length > 0) {

    parts.push(
      removedHeadings
        .map((heading) => `「${heading}」`)
        .join("と") +
      "を削除しました"
    );

  }

  return parts.join("、") + "。";

}
