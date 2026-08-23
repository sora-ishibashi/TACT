// =========================
// TACT Core — Capability Registry (STEP176)
// =========================
//
// 目的(STEP176絶対条件9): core/tact-core/* が core/tact-research/*
// (将来はcore/tact-design/*・core/tact-meeting/*等)を直接importして
// 「Coreが個々の能力を知っている」状態を作らない。代わりに、
// 名前ベースの登録/呼び出しだけを提供する、汎用的なRegistry/Service
// Locatorパターンを採用する。
//
// 依存方向:
//   core/tact-core/capabilities/registry.ts
//     → core/tact-core/types.ts(CoreCapability型)のみに依存
//     → core/tact-research/等を一切importしない
//
// 実際に「"research"という名前にrunResearch()を対応付ける」配線は、
// Core・Research双方をimportできる第三者(合成ルート)の責務とする
// (core/tact-bootstrap.ts参照)。これによりCore単体のテスト・利用が
// Researchの実装に一切依存しない状態を保てる。

import { CoreCapability } from "../types";

export type CapabilityHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  core: CoreCapability
) => Promise<TResult>;

const handlers = new Map<string, CapabilityHandler>();

// 同名の登録は上書きする(テスト時の再登録・開発時のホットリロードを
// 妨げないため)。多重登録を禁止する厳格なガードはSTEP176では設けない。
export function registerCapability<TParams, TResult>(
  name: string,
  handler: CapabilityHandler<TParams, TResult>
): void {

  handlers.set(name, handler as CapabilityHandler);

}

export function isCapabilityRegistered(
  name: string
): boolean {

  return handlers.has(name);

}

export async function invokeCapability<TParams, TResult>(
  name: string,
  params: TParams,
  core: CoreCapability
): Promise<TResult> {

  const handler = handlers.get(name);

  if (!handler) {

    throw new Error(
      `Capability "${name}" is not registered. ` +
      `Call registerCapability("${name}", ...) before invoking it ` +
      `(see core/tact-bootstrap.ts for the composition root).`
    );

  }

  return handler(params, core) as Promise<TResult>;

}

// unit test間での状態リークを避けるためだけの補助(本番用途ではない)。
export function clearCapabilityRegistry(): void {

  handlers.clear();

}
