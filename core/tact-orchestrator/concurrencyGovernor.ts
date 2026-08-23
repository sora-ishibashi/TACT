// =========================
// ConcurrencyGovernor (Phase 6)
// =========================
//
// Kimi Agent Swarm調査(直前のPhase)で確認した「resource lease」
// (session/subagent/subagentService.tsの
// `caller.accessor.get(IAgentRuntimeService).acquire(['process'])`
// + `finally`での確実な解放)という設計思想だけを採用する。Kimiの
// 実装そのものは移植しない(絶対条件: 今回採用するのはKimiの思想のみ)。
//
// 責務を極めて限定する(絶対条件2):
//   Governorが管理するもの: 同時実行Task数・acquire・release・
//   maxAgentsだけ。
//   Governorが判断しないもの: Task decomposition・Capability選択・
//   Provider選択・Memory retrieval・Retry・Task結果・Aggregation。
// 「このTaskを実行してよいか」ではなく「今、実行できる枠があるか」
// だけを管理する。
//
// 実装方式: Semaphoreパターン。busy loop/setInterval/pollingは一切
// 使わない(絶対条件6)。空き枠が無い場合はwaiterをキューへ積み、
// release()が呼ばれた瞬間に次のwaiterへ直接resolveする、完全に
// イベント駆動な待機。

export interface ConcurrencyLease {

  // 何度呼んでも安全(二重release対策、絶対条件: resource leakを
  // 絶対に起こさない。二重releaseによる枠の水増しも「安全でない」
  // 状態のため、2回目以降は無視する)。
  release(): void;

}

export interface ConcurrencyGovernor {

  acquire(): Promise<ConcurrencyLease>;

  // テスト・観測用(Governor自身の判断には使わない)。
  activeCount(): number;

  maxAgents(): number;

}

// STEP絶対条件7: TACTは300 Agent Swarmを目的としない。コスト・
// 安定性・予測可能性を優先する。Phase 3の設計方針(「最初は最大2〜3
// Agent程度でよい」)と揃え、安全な小さい既定値とする。
const DEFAULT_MAX_AGENTS = 3;

// OrchestrationRequest.constraints.maxAgents(Phase 1で型のみ定義済み、
// 今回初めて実際に参照する)から実効値を解決する、唯一の場所。
// 0以下や未指定は既定値へフォールバックする(0を指定すると永久に
// 誰もacquireできずデッドロックするため、最低1は保証する)。
export function resolveMaxAgents(
  constraints?: { maxAgents?: number }
): number {

  const requested = constraints?.maxAgents;

  if (
    typeof requested === "number" &&
    Number.isFinite(requested) &&
    requested >= 1
  ) {
    return Math.floor(requested);
  }

  return DEFAULT_MAX_AGENTS;

}

export function createConcurrencyGovernor(
  maxAgents: number
): ConcurrencyGovernor {

  const effectiveMax = Math.max(1, Math.floor(maxAgents));

  let active = 0;

  // FIFO待機列。並んだ順にacquireを許可する(Kimiのbackground task
  // queueと同じ、先着順のqueued待機)。
  const waiters: (() => void)[] = [];

  function acquire(): Promise<ConcurrencyLease> {

    return new Promise<ConcurrencyLease>((resolve) => {

      function grant(): void {

        active++;

        let released = false;

        resolve({

          release: () => {

            if (released) {
              return;
            }

            released = true;

            active--;

            // 待機中のTaskがいれば、空いた枠をそのまま直接引き継ぐ
            // (activeのincrement/decrementをここで対にする)。
            const next = waiters.shift();

            if (next) {
              next();
            }

          },

        });

      }

      if (active < effectiveMax) {

        // 絶対条件8: maxAgentsがTask数を超える場合、不要な待機を
        // 発生させない。空きがあれば即座にgrantする。
        grant();

      } else {

        waiters.push(grant);

      }

    });

  }

  return {

    acquire,

    activeCount: () => active,

    maxAgents: () => effectiveMax,

  };

}
