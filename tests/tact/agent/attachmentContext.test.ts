import { existsSync } from "node:fs";

import {
  attachmentStagingRoot,
  cleanupStagedAttachments,
  isSafeStagedAttachmentPath,
  stageCodeTaskAttachments,
  validateIncomingAttachment,
  validateIncomingAttachmentList,
} from "../../../core/codeAgent/attachmentContext";
import { check, summarize, type CheckResult } from "../lib/check";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];
  const image = {
    fileName: "reference.png",
    declaredMimeType: "image/png",
    bytes: PNG_SIGNATURE,
  };

  const valid = validateIncomingAttachment(image);

  results.push(
    check(
      "[TestS-1] PNGのMIME typeとmagic byteが一致する画像だけを許可する",
      valid.ok && valid.kind === "image" && valid.mimeType === "image/png"
    )
  );

  const mismatch = validateIncomingAttachment({
    ...image,
    declaredMimeType: "image/jpeg",
  });

  results.push(
    check(
      "[TestS-2] 申告MIME typeとmagic byteが不一致の画像を拒否する",
      !mismatch.ok
    )
  );

  const unsupported = validateIncomingAttachment({
    ...image,
    declaredMimeType: "application/pdf",
  });

  results.push(
    check(
      "[TestS-3] Phase117対象外のMIME typeを拒否する",
      !unsupported.ok
    )
  );

  results.push(
    check(
      "[TestS-4] 添付リストの枚数・合計サイズ検証が正常な1枚を通す",
      validateIncomingAttachmentList([image]).ok
    )
  );

  const staged = await stageCodeTaskAttachments("phase117test", [image]);
  const stagedFile = staged.attachments[0];

  results.push(
    check(
      "[TestS-5] 添付はRepository外のサーバー生成staging名へ配置され、CLI引数用パスとして安全",
      stagedFile.fileName === "reference.png" &&
        stagedFile.filePath.endsWith("attachment-1.png") &&
        stagedFile.filePath.startsWith(attachmentStagingRoot()) &&
        existsSync(stagedFile.filePath) &&
        isSafeStagedAttachmentPath(stagedFile.filePath)
    )
  );

  await cleanupStagedAttachments(staged.directory);

  results.push(
    check(
      "[TestS-6] 実行後cleanupはTask固有のstaging directoryを削除する",
      !existsSync(staged.directory)
    )
  );

  let unsafeKeyRejected = false;

  try {
    await stageCodeTaskAttachments("../outside", [image]);
  } catch {
    unsafeKeyRejected = true;
  }

  results.push(
    check(
      "[TestS-7] staging directory keyのパストラバーサルを拒否する",
      unsafeKeyRejected
    )
  );

  return summarize("attachment-context (Phase117)", results);

}
