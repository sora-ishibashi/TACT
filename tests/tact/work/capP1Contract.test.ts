import { registerCapability } from "../../../core/tact-core/capabilities/registry";
import { createMockCoreCapability } from "../../../core/tact-core/mockCoreCapability";
import { executeTask } from "../../../core/tact-orchestrator/executor";
import type { Task } from "../../../core/tact-orchestrator/task";
import type {
  CapabilityInvocationRequest,
  CapabilityInvocationResult,
} from "../../../core/tact-orchestrator/types";
import { resolveDelegatedWorkIntent } from "../../../core/tact-work/delegatedIntent";
import type { ContextResolutionPlan } from "../../../core/tact-context-resolution";
import { check, summarize, type CheckResult } from "../lib/check";

function makePlan(
  requestText: string,
  sources: ContextResolutionPlan["sources"]
): ContextResolutionPlan {
  return {
    kind: "ready",
    requestText,
    subject: { summary: "Customer renewal", queryTerms: ["Customer renewal"] },
    sources,
  };
}

function makeTask(description: string, assignedCapability: string): Task {
  return {
    id: crypto.randomUUID(),
    description,
    status: "pending",
    assignedCapability,
  };
}

const emptyTaskContext = {
  task: undefined as unknown as Task,
  coreContext: { knowledge: [], memories: [], examples: [], recentExecutions: [] },
  memoryReferences: [],
  dependencyResults: [],
};

export async function run(): Promise<{ pass: number; fail: number }> {
  const results: CheckResult[] = [];

  {
    const inspectIntent = resolveDelegatedWorkIntent(
      makePlan("最新の顧客メールを確認して", {
        notion: undefined,
        gmail: { query: "Customer renewal" },
      })
    );
    const actIntent = resolveDelegatedWorkIntent(
      makePlan("更新の返信を送って", {
        notion: undefined,
        gmail: { query: "Customer renewal" },
      })
    );

    results.push(check(
      "[CAP-P1 contract] Gmail-backed Work intent selects communication capabilities rather than Gmail or provider names",
      inspectIntent?.requiredCapabilities.length === 1 &&
        inspectIntent.requiredCapabilities[0] === "communication.read" &&
        actIntent?.requiredCapabilities.includes("communication.read") === true &&
        actIntent.requiredCapabilities.includes("communication.write") === true &&
        !JSON.stringify(inspectIntent).toLowerCase().includes("gmail") &&
        !JSON.stringify(actIntent).toLowerCase().includes("gmail")
    ));
  }

  {
    const workA = resolveDelegatedWorkIntent(
      makePlan("顧客メールを確認して", {
        notion: undefined,
        gmail: { query: "Customer renewal" },
      })
    );
    const workB = resolveDelegatedWorkIntent(
      makePlan("組織の方針を確認して", {
        notion: { query: "Renewal policy" },
        gmail: undefined,
      })
    );

    results.push(check(
      "[CAP-P1 contract] Work capability aggregation remains isolated between independent Works",
      JSON.stringify(workA?.requiredCapabilities) === JSON.stringify(["communication.read"]) &&
        JSON.stringify(workB?.requiredCapabilities) === JSON.stringify(["organizational_context.read"])
    ));
  }

  {
    const observed: { capability: string; query: string }[] = [];
    const capabilities = ["communication.read", "reasoning.generate", "communication.write"] as const;

    for (const capability of capabilities) {
      registerCapability<CapabilityInvocationRequest, CapabilityInvocationResult>(
        capability,
        async (request) => {
          observed.push({ capability, query: request.query });
          return { success: true, output: `${capability}:${request.query}` };
        }
      );
    }

    const summaries = await Promise.all(
      capabilities.map((capability) =>
        executeTask(
          makeTask(`Task for ${capability}`, capability),
          createMockCoreCapability(),
          emptyTaskContext
        )
      )
    );

    results.push(check(
      "[CAP-P1 contract] different Tasks retain distinct task-scoped canonical capabilities",
      summaries.every((summary, index) => summary.status === "completed" && summary.capability === capabilities[index]) &&
        observed.length === capabilities.length &&
        observed.every((entry, index) => entry.capability === capabilities[index] && entry.query === `Task for ${capabilities[index]}`)
    ));
  }

  {
    const queries: string[] = [];
    registerCapability<CapabilityInvocationRequest, CapabilityInvocationResult>(
      "organizational_context.read",
      async (request) => {
        queries.push(request.query);
        return { success: true, output: request.query };
      }
    );

    const first = await executeTask(
      makeTask("Read renewal policy", "organizational_context.read"),
      createMockCoreCapability(),
      emptyTaskContext
    );
    const second = await executeTask(
      makeTask("Read pricing policy", "organizational_context.read"),
      createMockCoreCapability(),
      emptyTaskContext
    );

    results.push(check(
      "[CAP-P1 contract] a canonical capability is reusable without cross-Task state contamination",
      first.status === "completed" &&
        second.status === "completed" &&
        first.capability === "organizational_context.read" &&
        second.capability === "organizational_context.read" &&
        JSON.stringify(queries) === JSON.stringify(["Read renewal policy", "Read pricing policy"])
    ));
  }

  return summarize("work/capP1Contract", results);
}
