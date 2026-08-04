import {
  BrainRule
} from "./types";

// ==========================
// Brain Memory
// ==========================

let brainMemory: BrainRule[] = [];


// ==========================
// 保存
// ==========================

export function saveBrainMemory(
  improvements: BrainRule[]
) {

  brainMemory.push(
    ...improvements
  );


  // 重複削除

  brainMemory =
    brainMemory.filter(
      (item, index, self) =>
        index ===
        self.findIndex(
          (x) =>
            x.rule === item.rule
        )
    );


  // 最大50件

  brainMemory =
    brainMemory.slice(
      -50
    );

}



// ==========================
// 取得
// ==========================

export function getBrainMemory() {

  return brainMemory;

}



// ==========================
// Prompt用
// ==========================

export function formatBrainMemory() {

  if (
    brainMemory.length === 0
  ) {

    return "None";

  }


  return brainMemory
    .map(
      (item) =>
        `
改善ルール:
${item.rule}

理由:
${item.reason}
`
    )
    .join("\n");

}