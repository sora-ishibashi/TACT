// =========================
// TACT Bootstrap (STEP176/178)
// =========================
//
// 「合成ルート(composition root)」。core/tact-core/*とcore/tact-research/*・
// core/tact-design/*は互いを一切importしない(STEP176絶対条件9・
// STEP178絶対条件)ため、両者を実際に結び付ける配線だけをこの
// ファイルに集約する。
//
// core/tact-core/capabilities/registry.tsは「名前と処理を対応付ける
// 場所」を提供するだけで、"research"や"design"が何であるかを知らない。
// このファイルだけが全てをimportし、registerCapability("research", ...)/
// registerCapability("design", ...)で実際の実装を注入する。
//
// 新しいTACT Architecture(Core→Research/Design/Meeting)を使う側
// (テストコード等)は、他のどのcore/tact-core呼び出しよりも先に
// bootstrapTactCapabilities()を1回呼ぶ想定。既存のLegacy Workflow
// Engine(core/workflow/index.tsのrunWorkflow()等)はこのファイルを
// 一切参照せず、従来通り動作する(STEP176絶対条件4・STEP178絶対条件)。

import { registerCapability } from "./tact-core";
import { runResearch } from "./tact-research";
import { runDesign } from "./tact-design";

let bootstrapped = false;

export function bootstrapTactCapabilities(): void {

  if (bootstrapped) {
    return;
  }

  registerCapability("research", runResearch);

  registerCapability("design", runDesign);

  bootstrapped = true;

}
