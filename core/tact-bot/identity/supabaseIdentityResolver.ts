// =========================
// TACT Bot — Supabase Identity Resolver (BOT-P2)
// =========================
//
// BotIdentityResolver(identity/resolver.ts、BOT-P1)の実装。
// BOT-P1のunresolvedIdentityResolver(常にnull)を置き換える、
// tact_external_identitiesを実際に検索する実装。receiveBotMessage()
// のdeps.identityResolverへ差し替えるだけで有効化できる
// (gateway側のロジック変更は不要、BOT-P1の設計通り)。
//
// "unknown" channelは常に未解決として扱う(そもそも紐付け対象外)。

import type { BotActor, BotChannel, BotIdentity } from "../types";
import type { BotIdentityResolver } from "./resolver";
import { findExternalIdentity, isLinkableChannel } from "./supabaseIdentityStore";

export const supabaseBotIdentityResolver: BotIdentityResolver = {

  async resolve(
    actor: BotActor,
    channel: BotChannel,
    externalWorkspaceId?: string
  ): Promise<BotIdentity | null> {

    if (!isLinkableChannel(channel)) {
      return null;
    }

    return findExternalIdentity({
      provider: channel,
      externalUserId: actor.externalUserId,
      externalWorkspaceId,
    });

  },

};
