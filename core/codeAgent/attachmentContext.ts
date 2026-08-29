// =========================
// Code Task Attachment Context(Phase117)
// =========================
//
// TACT Code UIでユーザーが添付した画像/ファイルを、Coding Agent
// (Claude Code / Codex)へ「画像そのもののContext」として渡すための、
// 受け取り→検証→一時ファイル配置(staging)→Prompt Block生成→cleanup
// だけを担うモジュール。
//
// 責務(このファイルがやること):
//   - 受け取ったバイト列の検証(MIME allowlist・magic byte・サイズ・件数)
//   - サーバー側で生成した安全なパスへの一時配置と、実行後のcleanup
//   - Adapterが使うPrompt Block(添付ファイルの所在を伝えるテキスト)の組み立て
//
// このファイルがやらないこと(既存責務を侵食しない):
//   - 画像の内容を文章化・要約すること。Phase117の絶対条件として、
//     添付画像を「白背景にカードがある」等の説明文へ変換して情報を
//     失わせる設計は採らない。画像の実体(ファイル)をそのままCoding
//     Agentへ渡し、解釈はAgent自身に任せる。
//   - Agent選択 / Handoff / Resume / Verification(すべて
//     core/tact-agent/側の既存責務のまま)。
//
// core/fileAnalysis/(STEP32、Chat添付)との関係:
//   core/fileAnalysis/extractFileContent.ts・describeImage.tsは
//   「添付ファイルをテキスト化してLLMのPromptへ載せる」ためのモジュール
//   であり、画像はdescribeImage()でVision APIによる説明文へ変換される
//   (=画像そのものは失われる)。Phase117が必要とするのは逆に
//   「画像の実体をCLIへ渡す」ことなので、要件が異なる。テキスト抽出を
//   一切行わないためロジックの重複も発生しない(Chat添付の経路は
//   無変更のまま残す)。
//
// Security(Phase117 Step6):
//   - ファイル名・パスをクライアントから受け取らない。保存先の
//     ディレクトリ名(=taskId、randomUUID由来)とファイル名
//     (attachment-N.<ext>)は、いずれもサーバー側で生成する。
//     元のファイル名はメタデータ(表示・Report用)としてのみ保持し、
//     パスとして使わない(パスインジェクション対策)。
//   - 拡張子はクライアント申告のMIME typeではなく、実バイト列の
//     magic byteから判定した結果に対応するものだけを使う。
//   - repositoryPath(Coding Agentが変更する対象)とは完全に別の
//     ディレクトリ(OSの一時ディレクトリ配下)へ配置する。添付ファイル
//     によってrepositoryPathや任意のOSパスが変わることはない。
//   - Repository内へ置かないため、`git status --porcelain`ベースの
//     changedFiles検出(claudeCodeAdapter.ts snapshotChangedFiles())が
//     添付ファイルを「Agentが変更したファイル」として誤検出すること
//     もない。

import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodeTaskAttachment, CodeTaskAttachmentKind } from "./types";

// Phase117の上限値。ローカルCLIへのファイル受け渡しの上限であり、
// 既存 /api/tact/attachments (STEP32、1ファイル15MB)とは用途が
// 異なるため独立した値を持つ(既存値は変更しない)。
export const MAX_ATTACHMENT_COUNT = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 1ファイル10MB
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 合計20MB

// Phase117は画像を第一優先とし、実際に受け付けるのは画像のみ。
// PDF/DOCX/XLSX等への拡張は、この表と判定関数を足すだけで済むよう、
// kind("image" | "document")を型に残している
// (CodeTaskAttachmentKind、core/codeAgent/types.ts)。
const IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

const STAGING_ROOT_DIR_NAME = "tact-code-attachments";

// staging先の絶対パスに許可する文字。shell:true(Windowsで.cmdを
// 起動するために既存Adapterが必須としている)経由でCLI引数へ載せる
// 可能性があるため、cmd.exeが特別扱いする文字(パーセント/アンパサンド/
// パイプ/リダイレクト/キャレット/引用符/バッククォート/セミコロン/改行等)を
// 一切含まないことを、実際にargvへ渡す前に確認する
// (core/codeAgent/claudeCodeAdapter.tsの「argsに可変文字列を
// 含めない」という既存の安全設計を、可変になる部分だけ検証で担保する)。
const SHELL_SAFE_PATH_PATTERN = /^[A-Za-z0-9 _\-./\\:]+$/;

// taskId(randomUUID由来)をディレクトリ名として使う前の検証。
const SAFE_DIRECTORY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

// =========================
// 受け取り時の入力(APIルートが組み立てる)
// =========================

export interface IncomingCodeTaskAttachment {

  // ユーザーが付けた元のファイル名。表示・Report用のメタデータとして
  // のみ使い、保存先のパスとしては一切使わない。
  fileName: string;

  // クライアントが申告したMIME type(検証の参考にはするが、最終判定は
  // magic byteで行う)。
  declaredMimeType: string;

  bytes: Buffer;

}

export type AttachmentValidationResult =
  | { ok: true; kind: CodeTaskAttachmentKind; mimeType: string; extension: string }
  | { ok: false; error: string };

// 実バイト列から画像形式を判定する(クライアント申告を信用しない)。
// 判定できない形式はundefinedを返し、呼び出し側で明確に拒否する。
export function detectImageMime(bytes: Buffer): string | undefined {

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return undefined;

}

export function validateIncomingAttachment(
  item: IncomingCodeTaskAttachment
): AttachmentValidationResult {

  if (item.bytes.length === 0) {
    return { ok: false, error: `"${item.fileName}" は空のファイルです` };
  }

  if (item.bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error:
        `"${item.fileName}" のサイズが上限(${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)を超えています`,
    };
  }

  const declaredMimeType = item.declaredMimeType.trim().toLowerCase();

  if (!IMAGE_MIME_TO_EXTENSION[declaredMimeType]) {
    return {
      ok: false,
      error:
        `"${item.fileName}" has an unsupported MIME type "${item.declaredMimeType || "(empty)"}". ` +
        "Phase117 accepts image/png, image/jpeg, and image/webp only.",
    };
  }

  const detected = detectImageMime(item.bytes);

  if (!detected) {
    return {
      ok: false,
      error:
        `"${item.fileName}" は対応していないファイル形式です` +
        "(Phase117はPNG / JPEG / WEBP画像のみ対応)",
    };
  }

  const extension = IMAGE_MIME_TO_EXTENSION[detected];

  if (!extension) {
    return {
      ok: false,
      error: `"${item.fileName}"(${detected})は対応していないファイル形式です`,
    };
  }

  if (declaredMimeType !== detected) {
    return {
      ok: false,
      error:
        `"${item.fileName}" MIME type does not match its file signature ` +
        `(${declaredMimeType} declared, ${detected} detected).`,
    };
  }

  return { ok: true, kind: "image", mimeType: detected, extension };

}

export type AttachmentListValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateIncomingAttachmentList(
  items: IncomingCodeTaskAttachment[]
): AttachmentListValidationResult {

  if (items.length > MAX_ATTACHMENT_COUNT) {
    return {
      ok: false,
      error: `添付できるファイル数の上限(${MAX_ATTACHMENT_COUNT}件)を超えています`,
    };
  }

  const totalBytes = items.reduce((sum, item) => sum + item.bytes.length, 0);

  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error:
        `添付ファイルの合計サイズが上限(${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB)を超えています`,
    };
  }

  for (const item of items) {

    const result = validateIncomingAttachment(item);

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

  }

  return { ok: true };

}

// =========================
// Staging(一時ファイル配置)
// =========================

export function attachmentStagingRoot(): string {
  return path.join(os.tmpdir(), STAGING_ROOT_DIR_NAME);
}

// 実際にCLI引数へ載せてよいパスかどうかの最終確認。
// (1) staging root配下であること、(2) shellが特別扱いする文字を
// 含まないこと、の両方を満たす場合のみtrue。
export function isSafeStagedAttachmentPath(filePath: string): boolean {

  if (!SHELL_SAFE_PATH_PATTERN.test(filePath)) {
    return false;
  }

  const relative = path.relative(attachmentStagingRoot(), filePath);

  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );

}

export interface StagedAttachments {

  // 今回のRunのために作成した一時ディレクトリ(cleanup対象)。
  directory: string;

  attachments: CodeTaskAttachment[];

}

// 検証済みの添付ファイルを、サーバーが生成したパスへ書き出す。
// directoryKeyにはtaskId(randomUUID)を渡す想定。
export async function stageCodeTaskAttachments(
  directoryKey: string,
  items: IncomingCodeTaskAttachment[]
): Promise<StagedAttachments> {

  if (!SAFE_DIRECTORY_KEY_PATTERN.test(directoryKey)) {
    throw new Error(
      `stageCodeTaskAttachments(): unsafe directory key "${directoryKey}"`
    );
  }

  const listValidation = validateIncomingAttachmentList(items);

  if (!listValidation.ok) {
    throw new Error(`stageCodeTaskAttachments(): ${listValidation.error}`);
  }

  const directory = path.join(attachmentStagingRoot(), directoryKey);

  await mkdir(directory, { recursive: true });

  try {
    const attachments: CodeTaskAttachment[] = [];

  for (let index = 0; index < items.length; index++) {

    const item = items[index];
    const validation = validateIncomingAttachment(item);

    if (!validation.ok) {
      // validateIncomingAttachmentList()で既に検証済みのため通常は
      // 到達しないが、型の網羅性と二重の安全弁のため残す。
      throw new Error(`stageCodeTaskAttachments(): ${validation.error}`);
    }

    const filePath = path.join(
      directory,
      `attachment-${index + 1}${validation.extension}`
    );

    await writeFile(filePath, item.bytes);

    attachments.push({
      id: `att-${index + 1}`,
      kind: validation.kind,
      mimeType: validation.mimeType,
      fileName: item.fileName,
      sizeBytes: item.bytes.length,
      filePath,
    });

  }

    return { directory, attachments };
  } catch (error) {
    await cleanupStagedAttachments(directory);
    throw error;
  }

}

// 実行後の一時ファイル削除。staging root配下でないパスは削除しない
// (誤った引数でRepositoryや任意のOSパスを消してしまわないための安全弁)。
export async function cleanupStagedAttachments(
  directory: string
): Promise<void> {

  const relative = path.relative(attachmentStagingRoot(), directory);

  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return;
  }

  await rm(directory, { recursive: true, force: true });

}

// =========================
// Prompt Block(Adapterが使う)
// =========================
//
// 添付ファイルの「内容の説明」ではなく、「どこに実体があるか」
// 「Taskとの関係(参考資料であって変更対象ではない)」だけを伝える
// テキスト。画像の内容の解釈はAgent自身が行う(このファイルは画像を
// 一切読み取らない)。

// 元のファイル名をPromptへ埋め込む際、Block構造(行区切り)を壊さない
// ように制御文字を除去し、長さを制限する(内容の改変・要約はしない)。
function sanitizeFileNameForPrompt(fileName: string): string {

  const singleLine = fileName.replace(/[\r\n\t]+/g, " ").trim();

  return singleLine.length > 120 ? `${singleLine.slice(0, 120)}...` : singleLine;

}

function formatAttachmentLine(
  attachment: CodeTaskAttachment,
  index: number,
  includePath: boolean
): string {

  const head =
    `${index + 1}. 元のファイル名: "${sanitizeFileNameForPrompt(attachment.fileName)}" ` +
    `(${attachment.mimeType}, ${attachment.sizeBytes.toLocaleString()} bytes)`;

  return includePath ? `${head}\n   パス: ${attachment.filePath}` : head;

}

const ATTACHMENT_SCOPE_NOTE =
  "これらの添付ファイルは、Taskの参考資料としてユーザーが渡したものである。" +
  "変更対象のRepositoryファイルではないため、編集・削除・移動をしてはならない" +
  "(Repositoryの外にある一時ファイルである)。";

// Claude Code CLI向け。Phase117時点のCLI(`claude --help`で確認)には
// 画像を直接添付するオプションが存在しないため、実体のファイルパスを
// 渡し、Claude Code自身のRead toolで画像として開かせる
// (画像を説明文へ変換して渡すのではなく、画像ファイルそのものを
// Agentに読ませる=情報を失わせない、Phase117の絶対条件)。
export function buildClaudeCodeAttachmentBlock(
  attachments: CodeTaskAttachment[]
): string {

  if (attachments.length === 0) {
    return "";
  }

  const lines: string[] = [
    "",
    "---",
    "",
    "## 添付ファイル(ユーザーがTACT Codeから添付した参考資料)",
    "",
    "実装を始める前に、Readツールで以下のファイルパスを開き、画像として内容を確認すること。",
    ATTACHMENT_SCOPE_NOTE,
    "",
  ];

  attachments.forEach((attachment, index) => {
    lines.push(formatAttachmentLine(attachment, index, true));
  });

  return lines.join("\n");

}

// Codex CLI向け。`codex exec -i/--image <FILE>`(`codex exec --help`で
// 確認)で画像をprompt本体へ添付できるため、そちらを主経路とする。
// このBlockは「何が添付されているか」のメタデータと、CLI引数として
// 渡せなかったファイル(パス検証に失敗した場合のみ)を正直に伝える
// ためのもの(渡せていないものを渡せたと書かない)。
export function buildCodexAttachmentBlock(
  attachedViaCli: CodeTaskAttachment[],
  notAttached: CodeTaskAttachment[]
): string {

  if (attachedViaCli.length === 0 && notAttached.length === 0) {
    return "";
  }

  const lines: string[] = [
    "",
    "---",
    "",
    "## 添付ファイル(ユーザーがTACT Codeから添付した参考資料)",
    "",
    ATTACHMENT_SCOPE_NOTE,
    "",
  ];

  if (attachedViaCli.length > 0) {

    lines.push(
      "以下の画像は、CLIの --image オプションでこのプロンプトへ添付済みであり、既に閲覧できる状態にある。",
      ""
    );

    attachedViaCli.forEach((attachment, index) => {
      lines.push(formatAttachmentLine(attachment, index, true));
    });

  }

  if (notAttached.length > 0) {

    lines.push(
      "",
      "以下の画像は、パスの安全性検証に失敗したため、このプロンプトへ添付できていない(閲覧できない)。",
      ""
    );

    notAttached.forEach((attachment, index) => {
      lines.push(formatAttachmentLine(attachment, index, false));
    });

  }

  return lines.join("\n");

}
