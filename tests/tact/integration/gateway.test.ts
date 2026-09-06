// =========================
// TACT Integration Gateway Regression (Architecture Migration Phase C1)
// =========================
//
// 対象: core/tact-integration/gateway.tsのexecuteIntegrationAction()。
// 実Composio API・実Supabaseには一切接続しない
// (IntegrationGatewayDeps経由でProvider実装を偽実装に差し替える)。
//
// 加えて、「@composio/coreのimportがcore/tact-integration/providers/
// composio/配下に閉じ込められているか」「Work/Bot/Conversation層が
// Composio SDKを直接知らないか」を、ソースコードの静的な文字列検査
// (grep相当)で確認する——Phase Aのcapability invocation decoupling
// testと同じ手法。

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { executeIntegrationAction } from "../../../core/tact-integration/gateway";
import type { IntegrationExecutionRequest, IntegrationExecutionResult, IntegrationProvider } from "../../../core/tact-integration/types";
import { check, summarize, type CheckResult } from "../lib/check";

const baseRequest: IntegrationExecutionRequest = {
  userId: "user-1",
  workId: "work-1",
  connectionId: "conn-1",
  providerConnectionRef: "ca_slack_123",
  action: { service: "slack", operation: "send_message", input: { channel: "#general", text: "hi" } },
};

function listTsFilesRecursively(dir: string): string[] {

  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {

    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...listTsFilesRecursively(fullPath));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(fullPath);
    }

  }

  return files;

}

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- 1. provider-neutral requestが登録済みProviderへdispatchされる ----
  {
    let capturedRequest: IntegrationExecutionRequest | undefined;

    const fakeProvider: IntegrationProvider = {
      execute: async (request) => {
        capturedRequest = request;
        return { status: "completed", providerExecutionRef: "log-1", output: { ok: true } };
      },
    };

    const result = await executeIntegrationAction(baseRequest, { provider: fakeProvider });

    results.push(
      check(
        "[Dispatch] executeIntegrationAction()は登録済みProviderへそのままdispatchする",
        result.status === "completed" &&
          capturedRequest?.action.service === "slack" &&
          capturedRequest?.action.operation === "send_message"
      )
    );
  }

  // ---- 3. Providerが返すfailed結果もそのまま透過する(Gateway自身は解釈しない) ----
  {
    const fakeProvider: IntegrationProvider = {
      execute: async (): Promise<IntegrationExecutionResult> => ({
        status: "failed",
        error: { code: "invalid_action", message: "unsupported", retryable: false },
      }),
    };

    const result = await executeIntegrationAction(baseRequest, { provider: fakeProvider });

    results.push(
      check(
        "[Safe failure] 未対応serviceに相当するProvider失敗も、Gatewayは例外を投げずそのまま返す",
        result.status === "failed" && result.error.code === "invalid_action"
      )
    );
  }

  // =========================
  // 静的確認: Composio SDK importのscope
  // =========================

  {
    const integrationRoot = join(__dirname, "../../../core/tact-integration");
    const files = listTsFilesRecursively(integrationRoot);

    const filesImportingComposio = files
      .filter((file) => !file.includes(join("providers", "composio")))
      .filter((file) => {
        const content = readFileSync(file, "utf-8");
        return /from\s+["']@composio\/core["']/.test(content);
      });

    results.push(
      check(
        "[静的確認] core/tact-integration/配下でproviders/composio/以外は@composio/coreを一切importしていない",
        filesImportingComposio.length === 0,
        filesImportingComposio.join(", ")
      )
    );
  }

  {
    const workRoot = join(__dirname, "../../../core/tact-work");
    const botRoot = join(__dirname, "../../../core/tact-bot");
    const conversationRoot = join(__dirname, "../../../core/tact-conversation");

    const allFiles = [
      ...listTsFilesRecursively(workRoot),
      ...listTsFilesRecursively(botRoot),
      ...listTsFilesRecursively(conversationRoot),
    ];

    const filesImportingComposio = allFiles.filter((file) => {
      const content = readFileSync(file, "utf-8");
      return /from\s+["']@composio\/core["']/.test(content);
    });

    results.push(
      check(
        "[静的確認] core/tact-work・core/tact-bot・core/tact-conversationはComposio SDKを一切importしていない(Work/Bot/ConversationはProviderを知らない)",
        filesImportingComposio.length === 0,
        filesImportingComposio.join(", ")
      )
    );
  }

  return summarize("integration/gateway", results);

}
