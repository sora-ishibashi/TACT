// =========================
// TACT Work — DB row ↔ domain mapping Regression
// (Architecture Migration Phase B1)
// =========================
//
// 対象: core/tact-work/store.tsのtoWork()/toWorkTask()/
// toTaskDependency()/toRun()/toApproval()(いずれも純粋関数、DB
// アクセスなし)。core/tact-conversation/store.tsの既存test
// (tactConversationMapping.test.ts)と同じ方針: このファイル自体は
// 実Supabase接続を行わない(LLM/Search API呼び出しも0件)。Stage1
// RLS・FK制約を含めた実DB上でのふるまいの検証は、別途一時スクリプト
// で実施する(tests/tact/の決定論的Harnessには含めない)。

import {
  toWork,
  toWorkTask,
  toTaskDependency,
  toRun,
  toApproval,
  type WorkRow,
  type WorkTaskRow,
  type TaskDependencyRow,
  type RunRow,
  type ApprovalRow,
} from "../../../core/tact-work/store";
import {
  WORK_STATUSES,
  TASK_STATUSES,
  RUN_STATUSES,
  APPROVAL_STATUSES,
} from "../../../core/tact-work/types";
import { check, summarize, type CheckResult } from "../lib/check";

export async function run(): Promise<{ pass: number; fail: number }> {

  const results: CheckResult[] = [];

  // ---- Test1: toWork() — 基本フィールド変換 ----
  {
    const row: WorkRow = {
      id: "work-1",
      user_id: "user-1",
      organization_id: null,
      created_by_actor_kind: "user",
      created_by_actor_id: "user-1",
      title: "競合分析",
      objective: null,
      subject: null,
      request_type: null,
      completion_conditions: null,
      required_capabilities: null,
      evidence_refs: null,
      result_delivered_at: null,
      status: "created",
      primary_conversation_id: "conv-1",
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      cost_summary: null,
      metadata: null,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    };

    const work = toWork(row);

    results.push(
      check(
        "[Test1] toWork(): 基本フィールドがsnake_case -> camelCaseへ変換される",
        work.id === "work-1" &&
          work.userId === "user-1" &&
          work.createdByActorKind === "user" &&
          work.createdByActorId === "user-1" &&
          work.primaryConversationId === "conv-1"
      )
    );

    results.push(
      check(
        "[Test1] toWork(): Work.id !== Conversation.id(独立したEntity)",
        work.id !== work.primaryConversationId
      )
    );
  }

  // ---- Test2: toWork() — 全WorkStatusが正しく往復する ----
  for (const status of WORK_STATUSES) {

    const row: WorkRow = {
      id: `work-${status}`,
      user_id: "user-1",
      organization_id: null,
      created_by_actor_kind: "system",
      created_by_actor_id: "scheduler",
      title: null,
      objective: null,
      subject: null,
      request_type: null,
      completion_conditions: null,
      required_capabilities: null,
      evidence_refs: null,
      result_delivered_at: null,
      status,
      primary_conversation_id: null,
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      cost_summary: null,
      metadata: null,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    };

    const work = toWork(row);

    results.push(
      check(
        `[Test2] toWork(): status="${status}"が正しく往復する`,
        work.status === status
      )
    );

  }

  // ---- Test3: toWorkTask() — Taskは所属Workを保持する ----
  {
    const row: WorkTaskRow = {
      id: "task-1",
      work_id: "work-1",
      parent_task_id: null,
      description: "競合3社を調査する",
      status: "pending",
      assigned_capability: "research",
      table_schema: null,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    };

    const task = toWorkTask(row);

    results.push(
      check(
        "[Test3] toWorkTask(): workIdを保持する(Task belongs to Work)",
        task.workId === "work-1"
      )
    );

    results.push(
      check(
        "[Test3] toWorkTask(): assignedCapabilityを保持するが、assignedProvider/assignedModelに相当するfieldを持たない",
        task.assignedCapability === "research" &&
          !("assignedProvider" in task) &&
          !("assignedModel" in task)
      )
    );
  }

  // ---- Test3-CAP-P1b: toWorkTask() — 実際のTask createシーケンス
  // (createTask() → toWorkTask())が、既存のexecution binding
  // (assignedCapability、dispatch key)を一切変更・削除せずに保持した
  // まま、read-only なCanonical Capability(canonicalCapabilities)を
  // 併記すること。resolveTaskCapabilities()を独立に呼ぶ単体testでは
  // なく、実際のDB row → domain変換関数(core/tact-work/store.tsの
  // createTask()が内部で呼ぶのと同じtoWorkTask())を直接通す ----
  {

    const gmailSearchRow: WorkTaskRow = {
      id: "task-gmail-search",
      work_id: "work-1",
      parent_task_id: null,
      description: "Gmailから対象案件を確認",
      status: "pending",
      assigned_capability: "integration.gmail.search_messages",
      table_schema: null,
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
    };

    const gmailSearchTask = toWorkTask(gmailSearchRow);

    results.push(
      check(
        "[Test3-CAP-P1b 1] Gmail search Task: canonical capability(communication.read)とexecution binding(integration.gmail.search_messages)が両方保持され、どちらか一方に潰れない",
        gmailSearchTask.assignedCapability === "integration.gmail.search_messages" &&
          JSON.stringify(gmailSearchTask.canonicalCapabilities) === JSON.stringify(["communication.read"])
      )
    );

    const gmailSendRow: WorkTaskRow = {
      ...gmailSearchRow,
      id: "task-gmail-send",
      assigned_capability: "integration.gmail.send_message",
    };

    const gmailSendTask = toWorkTask(gmailSendRow);

    results.push(
      check(
        "[Test3-CAP-P1b 2] Gmail send Task: canonical capability(communication.write)とexecution binding(integration.gmail.send_message)が両方保持される",
        gmailSendTask.assignedCapability === "integration.gmail.send_message" &&
          JSON.stringify(gmailSendTask.canonicalCapabilities) === JSON.stringify(["communication.write"])
      )
    );

    const notionSearchTask = toWorkTask({ ...gmailSearchRow, id: "task-notion-search", assigned_capability: "integration.notion.search" });
    const notionReadTask = toWorkTask({ ...gmailSearchRow, id: "task-notion-read", assigned_capability: "integration.notion.read_page" });

    results.push(
      check(
        "[Test3-CAP-P1b 3] Notion search/read_page Taskは既存語彙のorganizational_context.readへ解決される",
        JSON.stringify(notionSearchTask.canonicalCapabilities) === JSON.stringify(["organizational_context.read"]) &&
          JSON.stringify(notionReadTask.canonicalCapabilities) === JSON.stringify(["organizational_context.read"])
      )
    );

    const researchTask = toWorkTask({ ...gmailSearchRow, id: "task-research", assigned_capability: "research" });

    results.push(
      check(
        '[Test3-CAP-P1b 4] Research Taskはresearch.performへ解決される(Work.requiredCapabilitiesへは一切書き込まれない、このfileはWorkへの書き込みを一切行わない)',
        JSON.stringify(researchTask.canonicalCapabilities) === JSON.stringify(["research.perform"])
      )
    );

    const unknownTask = toWorkTask({ ...gmailSearchRow, id: "task-unknown", assigned_capability: "integration.unknown_provider.some_action" });

    results.push(
      check(
        "[Test3-CAP-P1b 5] 未登録のexecution binding(dispatch key)はcanonicalCapabilities=null(fail closed、推測しない)。ただしTask自体(assignedCapability・id等)は変更されずそのまま残る——canonical capabilityが解決できないことがTaskの存在/実行を妨げない",
          unknownTask.canonicalCapabilities === null &&
          unknownTask.assignedCapability === "integration.unknown_provider.some_action" &&
          unknownTask.id === "task-unknown"
      )
    );

    const chatTask = toWorkTask({ ...gmailSearchRow, id: "task-chat", assigned_capability: null });

    results.push(
      check(
        "[Test3-CAP-P1b 6] assignedCapability未設定(chatフォールバック)のTaskはcanonicalCapabilities=null",
        chatTask.canonicalCapabilities === null
      )
    );

  }

  // ---- Test4: toWorkTask() — 全TaskStatusが正しく往復する ----
  for (const status of TASK_STATUSES) {

    const row: WorkTaskRow = {
      id: `task-${status}`,
      work_id: "work-1",
      parent_task_id: null,
      description: "テスト",
      status,
      assigned_capability: null,
      table_schema: null,
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
    };

    const task = toWorkTask(row);

    results.push(
      check(
        `[Test4] toWorkTask(): status="${status}"が正しく往復する`,
        task.status === status
      )
    );

  }

  // ---- Test5: toTaskDependency() ----
  {
    const row: TaskDependencyRow = {
      task_id: "task-2",
      depends_on_task_id: "task-1",
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const dependency = toTaskDependency(row);

    results.push(
      check(
        "[Test5] toTaskDependency(): taskId/dependsOnTaskIdが正しく変換される",
        dependency.taskId === "task-2" && dependency.dependsOnTaskId === "task-1"
      )
    );
  }

  // ---- Test6: toRun() — RunはTask/Workの両方を保持する ----
  {
    const row: RunRow = {
      id: "run-1",
      work_id: "work-1",
      task_id: "task-1",
      attempt: 1,
      capability: "research",
      provider: "openai",
      model: "gpt-4o-mini",
      status: "completed",
      started_at: "2026-09-05T00:00:00.000Z",
      completed_at: "2026-09-05T00:01:00.000Z",
      error: null,
      cost: { tokens: 100, estimatedUSD: 0.001 },
      external_ref: null,
      result: { success: true, output: "回答" },
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const run = toRun(row);

    results.push(
      check(
        "[Test6] toRun(): workId/taskIdの両方を保持する(Run belongs to Task + Work)",
        run.workId === "work-1" && run.taskId === "task-1"
      )
    );

    results.push(
      check(
        "[Test6] toRun(): attempt/provider/model/cost/resultが正しく変換される",
        run.attempt === 1 &&
          run.provider === "openai" &&
          run.model === "gpt-4o-mini" &&
          run.cost?.tokens === 100 &&
          run.result?.success === true
      )
    );
  }

  // ---- Test6-CAP-P1b: toRun() — Run traceability(「なぜこのRunが
  // 実行されたか」をRun単体から辿れる)。実際のcreateRun()が内部で
  // 呼ぶのと同じtoRun()を直接通す ----
  {

    const gmailSearchRunRow: RunRow = {
      id: "run-gmail-search",
      work_id: "work-1",
      task_id: "task-gmail-search",
      attempt: 1,
      capability: "integration.gmail.search_messages",
      provider: "composio",
      model: null,
      status: "completed",
      started_at: "2026-09-14T00:00:00.000Z",
      completed_at: "2026-09-14T00:01:00.000Z",
      error: null,
      cost: null,
      external_ref: null,
      result: { success: true },
      created_at: "2026-09-14T00:00:00.000Z",
    };

    const gmailSearchRun = toRun(gmailSearchRunRow);

    results.push(
      check(
        "[Test6-CAP-P1b 1] Gmail search Run: capability(execution binding、既存値、providerと結びついたdispatch key)とcanonicalCapabilities(communication.read)が両方保持され、Run単体からTask経由の追加JOINなしにcanonical capabilityを読める",
        gmailSearchRun.capability === "integration.gmail.search_messages" &&
          gmailSearchRun.provider === "composio" &&
          JSON.stringify(gmailSearchRun.canonicalCapabilities) === JSON.stringify(["communication.read"])
      )
    );

    const unknownRun = toRun({ ...gmailSearchRunRow, id: "run-unknown", capability: "integration.unknown_provider.some_action" });

    results.push(
      check(
        "[Test6-CAP-P1b 2] 未登録のexecution binding(dispatch key)を持つRunもcanonicalCapabilities=null(fail closed)のまま、Run自体(capability/provider/result等)は変更されず記録される",
        unknownRun.canonicalCapabilities === null &&
          unknownRun.capability === "integration.unknown_provider.some_action" &&
          unknownRun.result?.success === true
      )
    );

    const chatRun = toRun({ ...gmailSearchRunRow, id: "run-chat", capability: "chat" });

    results.push(
      check(
        '[Test6-CAP-P1b 3] "chat"(Capability Registry未経由の既定経路)のRunもcanonicalCapabilities=null(chatはWorkCapabilityRequirement/research.performのいずれにも該当しない)',
        chatRun.canonicalCapabilities === null
      )
    );

  }

  // ---- Test7: toRun() — 全RunStatusが正しく往復する(cancelledは無い) ----
  for (const status of RUN_STATUSES) {

    const row: RunRow = {
      id: `run-${status}`,
      work_id: "work-1",
      task_id: "task-1",
      attempt: 1,
      capability: "research",
      provider: null,
      model: null,
      status,
      started_at: "2026-09-05T00:00:00.000Z",
      completed_at: null,
      error: null,
      cost: null,
      external_ref: null,
      result: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const run = toRun(row);

    results.push(
      check(
        `[Test7] toRun(): status="${status}"が正しく往復する`,
        run.status === status
      )
    );

  }

  // ---- Test8: toApproval() — ApprovalはWorkに属する ----
  {
    const row: ApprovalRow = {
      id: "approval-1",
      work_id: "work-1",
      task_id: "task-1",
      requested_by_actor_kind: "ai",
      requested_by_actor_id: "tact-research",
      requested_from_actor_kind: "user",
      requested_from_actor_id: "user-1",
      status: "pending",
      reason: "外部SaaSへの書き込み前確認",
      payload: { type: "slack_post", preview: "..." },
      requested_at: "2026-09-05T00:00:00.000Z",
      responded_at: null,
      response: null,
      expires_at: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const approval = toApproval(row);

    results.push(
      check(
        "[Test8] toApproval(): workIdを保持する(Approval belongs to Work)",
        approval.workId === "work-1"
      )
    );

    results.push(
      check(
        "[Test8] toApproval(): 型付きActor参照(requestedBy/requestedFrom)が正しく変換される",
        approval.requestedByActorKind === "ai" &&
          approval.requestedByActorId === "tact-research" &&
          approval.requestedFromActorKind === "user" &&
          approval.requestedFromActorId === "user-1"
      )
    );
  }

  // ---- Test9: toApproval() — 全ApprovalStatusが正しく往復する ----
  for (const status of APPROVAL_STATUSES) {

    const row: ApprovalRow = {
      id: `approval-${status}`,
      work_id: "work-1",
      task_id: null,
      requested_by_actor_kind: "system",
      requested_by_actor_id: "scheduler",
      requested_from_actor_kind: "user",
      requested_from_actor_id: "user-1",
      status,
      reason: "テスト",
      payload: {},
      requested_at: "2026-09-05T00:00:00.000Z",
      responded_at: null,
      response: null,
      expires_at: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const approval = toApproval(row);

    results.push(
      check(
        `[Test9] toApproval(): status="${status}"が正しく往復する`,
        approval.status === status
      )
    );

  }

  // ---- Test10: toApproval() — Approval Integrity列(ARCH-P1a) ----
  {

    // ARCH-P1a時点の既存Approval相当: 新列を一切含まないrow
    // (=既存本番rowと同じ形、新列がoptionalであることの直接確認)。
    const legacyRow: ApprovalRow = {
      id: "approval-legacy",
      work_id: "work-1",
      task_id: "task-1",
      requested_by_actor_kind: "ai",
      requested_by_actor_id: "tact-research",
      requested_from_actor_kind: "user",
      requested_from_actor_id: "user-1",
      status: "pending",
      reason: "テスト",
      payload: {},
      requested_at: "2026-09-05T00:00:00.000Z",
      responded_at: null,
      response: null,
      expires_at: null,
      created_at: "2026-09-05T00:00:00.000Z",
    };

    const legacyApproval = toApproval(legacyRow);

    results.push(
      check(
        "[Test10] Approval Integrity列を含まないrow(既存本番row相当)はsubjectVersion等がすべてundefinedのまま安全にtoApproval()できる",
        legacyApproval.subjectVersion === undefined &&
          legacyApproval.subject === undefined &&
          legacyApproval.subjectHash === undefined &&
          legacyApproval.subjectCapturedAt === undefined
      )
    );

    // ARCH-P1b以降を想定した、新列がNULLで明示されているrow。
    const nullRow: ApprovalRow = {
      ...legacyRow,
      id: "approval-null-subject",
      subject_version: null,
      subject_json: null,
      subject_hash: null,
      subject_captured_at: null,
    };

    const nullApproval = toApproval(nullRow);

    results.push(
      check(
        "[Test10] Approval Integrity列が明示的にNULLのrowは、そのままnullとして伝播する(余計な正規化をしない)",
        nullApproval.subjectVersion === null &&
          nullApproval.subject === null &&
          nullApproval.subjectHash === null &&
          nullApproval.subjectCapturedAt === null
      )
    );

    // 新列に実際に値が入っているrow(将来ARCH-P1b以降の想定形)。
    const populatedRow: ApprovalRow = {
      ...legacyRow,
      id: "approval-with-subject",
      subject_version: 1,
      subject_json: { subjectVersion: 1, workId: "work-1" },
      subject_hash: "a".repeat(64),
      subject_captured_at: "2026-09-09T00:00:00.000Z",
    };

    const populatedApproval = toApproval(populatedRow);

    results.push(
      check(
        "[Test10] Approval Integrity列に値がある場合、そのままdomain型へ変換される",
        populatedApproval.subjectVersion === 1 &&
          populatedApproval.subjectHash === "a".repeat(64) &&
          populatedApproval.subjectCapturedAt === "2026-09-09T00:00:00.000Z" &&
          JSON.stringify(populatedApproval.subject) === JSON.stringify({ subjectVersion: 1, workId: "work-1" })
      )
    );

  }

  return summarize("work/mapping", results);

}
