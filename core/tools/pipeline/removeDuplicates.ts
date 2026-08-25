// Phase93: core/tact-research/runResearch.tsがDiscovery/Deepening両方の
// Evidenceを統合する際にも、新しい重複判定ロジックを作らずこの既存
// 汎用関数をそのまま再利用する(呼び出し元を増やしても本体は無変更)。
export function removeDuplicates<T>(
  items: T[],
  key: (item: T) => string
): T[] {

  const map = new Map<string, T>();

  for (const item of items) {

    map.set(
      key(item),
      item
    );

  }

  return [...map.values()];

}