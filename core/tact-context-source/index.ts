// =========================
// TACT Context Source — Public Entry Point (LW-P0)
// =========================
//
// core/tact-context-source/配下の型・純粋関数を一括で参照できるように
// する入口。core/tact-core/index.tsと同じ考え方(公開境界を1箇所へ
// 集約する)。
//
// LW-P1: entryTree.ts(DOM非依存のpure function)を追加した。ただし
// Browser adapter(localWorkspace/browserAdapter.ts)・IndexedDB永続化
// (localWorkspace/handleStore.ts)は、Browser固有型に依存するため
// 意図的にここへ含めない(LW-P0からの設計方針を継続)。これらは
// components/tact/localWorkspace/側から直接パスを指定してimportする。
//
// LW-P2: search.ts(metadata検索)・localWorkspace/readPolicy.ts
// (対応拡張子・size/content上限)・localWorkspace/contentIndex.ts
// (軽量content index)を追加した。いずれもDOM非依存のpure functionの
// ため、Browser adapterと違いここに含める。
//
// LW-P3: localWorkspace/resolver.ts(Workspace Context Resolverの
// pure function群)・localWorkspace/requestValidation.ts(server側
// workspaceEvidence validation)を追加した。同じ理由でDOM非依存のため
// ここに含める(requestValidation.tsはむしろserver専用だが、DOM/
// Browser API非依存という基準は変わらないため同じ扱いにする)。

export * from "./types";
export * from "./filtering";
export * from "./entryTree";
export * from "./search";
export * from "./localWorkspace/types";
export * from "./localWorkspace/toEvidence";
export * from "./localWorkspace/readPolicy";
export * from "./localWorkspace/contentIndex";
export * from "./localWorkspace/resolver";
export * from "./localWorkspace/requestValidation";
