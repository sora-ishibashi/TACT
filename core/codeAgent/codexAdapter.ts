// =========================
// CodexAdapter(Phase104で骨組みのみ追加、Phase110で実行経路を接続)
// =========================
//
// core/codeAgent/adapterRegistry.tsの既存拡張点(コメントに
// "codex" → 将来と既に明記されている)を実際のAdapterとして埋める。
//
// Phase110調査(絶対条件: 推測でCodexが利用可能だと扱わない・架空の
// CLI/API/環境変数を作らない):
// - この環境には元々`codex`コマンドは存在しなかった(PATH・
//   `npm list -g`・node_modulesいずれにも無し、.envにもCodex固有の
//   認証情報は無かった)。
// - `npm view @openai/codex`(読み取り専用、インストールなし)で、
//   OpenAI公式のCodex CLIが実在するnpmパッケージであることを確認
//   した上で、ユーザーの明示的な承認を得てから
//   `npm install -g @openai/codex`でインストールした(架空の実装では
//   なく、実在する公式CLIを実際にインストールして接続している)。
// - 認証は`codex login --with-api-key`(公式にドキュメントされた
//   非対話認証手段、`codex login --help`参照)へ、既存の
//   `.env`のOPENAI_API_KEY(このリポジトリで既に他の用途にも
//   使われている実在のキー)を渡すことで確立した。新しい環境変数・
//   新しい認証方式は作っていない。
// - `codex doctor`で`auth is configured / auth mode: api_key`を
//   実機で確認済み。
//
// 実行方式(ClaudeCodeAdapter.tsと対になる設計、同じ理由で同じ形にする):
// - 非対話実行は`codex exec`サブコマンド(`codex exec --help`で確認)。
// - Windows固有の注意はClaudeCodeAdapter.tsと同一:
//   npmがグローバルインストールするCLIの実体は`codex.cmd`であり、
//   shell:trueなしでは起動できない(CVE-2024-27980対応後の挙動)。
// - Instruction本文は、ClaudeCodeAdapter.tsと同じ理由(shell:true下で
//   動的文字列をCLI引数に渡すシェルインジェクションのリスクを避ける
//   ため)で、CLI引数ではなくstdinへ書き込む(`codex exec`は
//   「PROMPT引数が無い場合はstdinから読む」と明記されている)。
// - 同じ理由で、working directoryもCLI引数(--cd)には渡さず、
//   spawn()自体のcwdオプション(Node側の設定であり、シェルには
//   渡らない)だけで指定する。argsは完全に静的な固定フラグのみとし、
//   Task由来の可変文字列を一切含めない(ClaudeCodeAdapter.tsと
//   同じ制約)。
// - `--dangerously-bypass-approvals-and-sandbox`は、
//   ClaudeCodeAdapter.tsの`--dangerously-skip-permissions`と同じ設計
//   判断: 非対話プロセスは対話的な承認プロンプトを出せないため必須。
//   `codex doctor`でこの環境のWindows sandboxプロビジョニングが
//   構造的に失敗する("elevated Windows sandbox provisioning
//   recorded a structured failure")ことを確認済みのため、
//   sandboxモード(-s workspace-write等)には依存しない。
//   このAdapterはstatus==="approved"のTaskにしか使わないため、
//   「人間が承認したTaskに対してのみ」この権限で動く設計は
//   ClaudeCodeAdapterと変わらない。
// - changedFilesの検出は、ClaudeCodeAdapter.ts側の
//   snapshotChangedFiles()/computeChangedFiles()をそのまま再利用する
//   (「既存の仕組みで取得できる」絶対条件、重複実装しない)。
//
// Phase111(Section5): Phase110のReality Testで、`codex exec`が
// モデル/reasoning effort未指定時にこの環境のCLIデフォルト
// (`gpt-5.6-terra` / `xhigh`)を選ぶことを実機で確認した。実運用コストを
// 考慮し、model/reasoningEffortをAdapter側で明示的に設定できるように
// する(絶対条件: 今回、最適な値を勝手に決めて既定値を変更したりは
// しない。設定注入可能な構造だけを用意し、未設定時の挙動はPhase110まで
// と完全に同じ=CLI自身のデフォルトのまま)。
// 環境変数(CODEX_MODEL/CODEX_REASONING_EFFORT)からも読めるようにし、
// 明示的なコンストラクタ引数が優先される。

import { execFile, spawn } from "node:child_process";

import {
  CodeTask,
  CodeTaskAttachment,
  CodeTaskAttachmentDelivery,
  CodeTaskExecutionResult,
  CodingAgentAdapter,
} from "./types";
import { snapshotChangedFiles, computeChangedFiles } from "./claudeCodeAdapter";
import {
  buildCodexAttachmentBlock,
  isSafeStagedAttachmentPath,
} from "./attachmentContext";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10分(ClaudeCodeAdapterと同じ既定値)

const OUTPUT_CAPTURE_LIMIT = 20000;

// `codex login status`(固定・静的な引数のみ、副作用なしの読み取り
// 専用コマンド)の実行。ClaudeCodeAdapter.tsのcheckClaudeVersion()と
// 同じ理由で"codex.cmd"と拡張子を明示する(この環境ではshell:true
// 経由の拡張子なしコマンド名解決が失敗することをPhase106/107で
// 確認済み)。
function checkCodexLoginStatus(): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {

  return new Promise((resolve) => {

    execFile(
      "codex.cmd",
      ["login", "status"],
      { cwd: process.cwd(), timeout: 10_000, shell: true },
      (error, stdout, stderr) => {

        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;

        resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });

      }
    );

  });

}

// codex exec を、Instruction本文をCLI引数に含めずstdin経由で実行する。
// model/reasoningEffortはAdapterの設定(コンストラクタ引数または
// 環境変数)由来の値であり、Task本文(LLM/ユーザー由来の可変文字列)
// ではない。ただしshell:true下のargv注入リスクを避ける設計方針は
// 変わらないため、値自体は変えずそのままargvへ載せる(TOMLの
// 文字列リテラルとして解釈させるため引用符で囲む)。
function runCodexWithStdin(
  instruction: string,
  options: {
    cwd: string;
    timeout: number;
    model?: string;
    reasoningEffort?: string;
    // Phase117: `codex exec -i/--image <FILE>`へ渡す画像の絶対パス。
    // 呼び出し側(execute())が既にisSafeStagedAttachmentPath()で
    // 検証したものだけを受け取る。
    imagePaths?: string[];
  }
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {

  const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];

  if (options.model) {
    args.push("-m", options.model);
  }

  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }

  // Phase117: 画像はCodex CLI自身の添付オプション(`codex exec --image`、
  // `codex exec --help`で確認)で渡す(説明文へ変換しない)。
  // ここに載るのはTask本文ではなく、サーバー側が生成した一時ファイルの
  // パスのみであり、かつisSafeStagedAttachmentPath()で
  // 「staging root配下」かつ「shellが特別扱いする文字を含まない」ことを
  // 検証済みの値だけを受け取る。shell:true下でcmd.exeへ渡るため、
  // 空白を含むパスがそのまま分割されないよう二重引用符で囲む。
  for (const imagePath of options.imagePaths ?? []) {
    args.push("-i", `"${imagePath}"`);
  }

  return new Promise((resolve) => {

    const child = spawn(
      "codex.cmd",
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        shell: true,
      }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < OUTPUT_CAPTURE_LIMIT) {
        stdout += chunk.toString();
      }
    });

    child.stderr?.on("data", (chunk) => {
      if (stderr.length < OUTPUT_CAPTURE_LIMIT) {
        stderr += chunk.toString();
      }
    });

    child.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + "\n" + String(err),
        timedOut: false,
      });
    });

    child.on("close", (code, signal) => {
      if (signal === "SIGTERM") {
        timedOut = true;
      }
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
      });
    });

    child.stdin?.write(instruction);
    child.stdin?.end();

  });

}

export interface CodexAdapterConfig {

  // 未指定時はCLI自身の既定モデルのまま(Phase111では既定値を変更しない)。
  model?: string;

  // "low" | "medium" | "high" | "xhigh" 等、codex CLIが受け付ける値を
  // そのまま渡す(このAdapter自身は値の妥当性を検証・推測しない)。
  reasoningEffort?: string;

}

export class CodexAdapter implements CodingAgentAdapter {

  readonly id = "codex";

  private readonly model?: string;

  private readonly reasoningEffort?: string;

  constructor(config: CodexAdapterConfig = {}) {

    this.model = config.model ?? process.env.CODEX_MODEL;
    this.reasoningEffort = config.reasoningEffort ?? process.env.CODEX_REASONING_EFFORT;

  }

  async isAvailable(): Promise<{
    available: boolean;
    detail: string;
  }> {

    const result = await checkCodexLoginStatus();

    if (result.exitCode === 0) {
      return {
        available: true,
        detail: result.stdout.trim(),
      };
    }

    return {
      available: false,
      detail:
        result.stderr.trim() ||
        result.stdout.trim() ||
        `codex login status exited with code ${result.exitCode}`,
    };

  }

  async execute(
    task: CodeTask
  ): Promise<CodeTaskExecutionResult> {

    if (task.status !== "approved") {

      throw new Error(
        `CodeTask ${task.id} is not approved (status=${task.status}). ` +
        "CodexAdapter.execute() refuses to run unapproved tasks."
      );

    }

    const startedAt = Date.now();

    // Phase117: 添付ファイルは、Codex CLI自身の画像添付オプション
    // (`-i/--image`)でprompt本体へ渡す。パス検証(staging root配下・
    // shell安全)に失敗したものはCLI引数へ載せず、「渡せていない」と
    // 正直に記録する(渡せていないものを渡したことにしない)。
    const attachments = task.attachments ?? [];

    const attachableViaCli: CodeTaskAttachment[] = [];
    const notAttached: CodeTaskAttachment[] = [];

    for (const attachment of attachments) {

      if (attachment.kind === "image" && isSafeStagedAttachmentPath(attachment.filePath)) {
        attachableViaCli.push(attachment);
      } else {
        notAttached.push(attachment);
      }

    }

    const attachmentDelivery: CodeTaskAttachmentDelivery[] = [
      ...attachableViaCli.map((attachment): CodeTaskAttachmentDelivery => ({
        attachmentId: attachment.id,
        method: "cli_image_argument",
        detail:
          `codex exec の --image 引数として実体パス(${attachment.filePath})を渡した。`,
      })),
      ...notAttached.map((attachment): CodeTaskAttachmentDelivery => ({
        attachmentId: attachment.id,
        method: "not_delivered",
        detail:
          attachment.kind === "image"
            ? "一時ファイルのパスが安全性検証(staging root配下・shell安全な文字のみ)を通らなかったため、CLIへ渡していない。"
            : `kind="${attachment.kind}" はPhase117のCodex経路では未対応のため、CLIへ渡していない。`,
      })),
    ];

    const attachmentBlock = buildCodexAttachmentBlock(attachableViaCli, notAttached);

    const before =
      await snapshotChangedFiles(task.repositoryPath);

    const result = await runCodexWithStdin(
      task.instruction + attachmentBlock,
      {
        cwd: task.repositoryPath,
        timeout: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        imagePaths: attachableViaCli.map((attachment) => attachment.filePath),
      }
    );

    const after =
      await snapshotChangedFiles(task.repositoryPath);

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, OUTPUT_CAPTURE_LIMIT),
      stderr: result.stderr.slice(0, OUTPUT_CAPTURE_LIMIT),
      changedFiles: computeChangedFiles(before, after),
      durationMs: Date.now() - startedAt,
      timedOut: result.timedOut,
      attachmentDelivery:
        attachmentDelivery.length > 0 ? attachmentDelivery : undefined,
    };

  }

}
