// =========================
// Git State Capture(Handoff用)
// =========================
//
// Step5: 「どのcommitを基準に、どの変更状態で引き継いだか」を
// 記録するためだけの最小連携。Git操作の実装(git status等の実行)は
// core/codeAgent/gitProvider.tsのGitProvider.status()をそのまま
// 再利用し、ここで重複実装しない。TACT Core自身がcommit/pushを
// 行う機能は今回作らない(絶対条件、Step5)。

import { getGitProvider } from "../codeAgent/gitProvider";
import { HandoffGitState } from "./types";

export async function captureGitState(
  repositoryPath: string
): Promise<HandoffGitState> {

  const status = await getGitProvider().status(repositoryPath);

  return {
    branch: status.branch,
    lastCommit: status.headCommit,
    workingTreeStatus: status.dirtyFiles.length > 0 ? "dirty" : "clean",
    dirtyFileCount: status.dirtyFiles.length,
    capturedAt: new Date().toISOString(),
  };

}
