# Source

- Project / Product name: 対象不確定（"chowki" という名称に一致し、かつ checkpoint／exact-step resume／approval token／append-only audit log／secret redaction というproblem spaceに合致する実在プロジェクトを特定できなかった）
- Repository URL: 不明
- Official docs URL: 不明
- License: 不明
- License evidence: 不明
- Last checked date: 2026-09-07
- Repository activity / maintenance status: 不明
- Exact version / commit inspected if possible: 不明

# Problem Solved

対象不確定のため記載なし（捏造回避のため、存在しないプロジェクトの問題設定を作文しない）。

# Architecture

対象不確定のため記載なし。

- Core concepts: 不明
- Main entities: 不明
- State machine: 不明
- Execution model: 不明
- Persistence model: 不明
- Human interaction model: 不明
- Retry / recovery: 不明
- Permission / policy: 不明
- Audit: 不明
- Credential handling: 不明
- Provider/runtime coupling: 不明

# State Machine

Implemented:
(なし — 対象プロジェクトを特定できなかったため、コード/ドキュメントを確認できていない)

Inferred:
(なし)

対象を特定できていないため、実装されているState Machineの有無自体を確認できていない。

# TACT Equivalent

対象不確定のため、マッピングは行わない（存在しないプロジェクトの設計をTACTの語彙に無理やり当てはめることは、捏造防止ルールに反するため）。

# Reusable Code

None（対象プロジェクトを特定できていないため、再利用候補コードは存在しない）。

# Reusable Schema

None（同上）。

# Reusable Pattern

None（同上。なお、checkpoint+resume・approval binding・claim-before-executeといったパターン自体は一般的な設計パターンとして存在するが、これらは"chowki"という具体的なOSS/製品の実装に由来する知見として提示できるものではないため、本ファイルでは記載しない）。

# Reusable UX

None（対象プロジェクトを特定できていないため）。

# Risks

- License: 不明（対象未特定）
- Security: 不明
- Provider lock-in: 不明
- Runtime lock-in: 不明
- Architecture mismatch: 不明
- Agent-centric bias: 不明
- Overengineering: 不明
- Scaling concern: 不明
- Persistence mismatch: 不明
- Multi-tenant concern: 不明
- Secret handling: 不明

# Classification

REJECT（この調査対象について — 実在性を確認できないプロジェクトを前提資産として扱うことはできないため。個別の技術・パターンに対する分類ではなく、「chowki」という調査対象そのものについての結論）

# Recommendation

## Adopt

なし。

## Do Not Adopt

「chowki」という名称のプロジェクトを、checkpoint／exact-step resume／approval token／append-only audit log／secret redactionの文脈でのPrior Art（参照元）として採用しない。

## Why

徹底的な調査（GitHub repository検索、npm検索、PyPI検索、Google/一般Web検索を複数の言い回しで実施、Hacker News検索、MCP/agent framework関連検索を実施）を行ったが、"chowki" という名称で、かつ本タスクが要求する問題領域（workflow checkpointing / exact-step resume / approval token / append-only audit log / secret redaction）に合致する実在プロジェクトを発見できなかった。

見つかった "chowki" に近い名称の候補は以下の通りだが、いずれも問題領域が一致しないため対象外とした：

1. **stakater/Chowkidar**（GitHub, Go, 55 stars）— Kubernetesイベントを監視し設定されたアクションを実行するcontroller。checkpoint/resume/approvalの文脈とは無関係。
2. **gnulinuxindia/internet-chowkidar**（GitHub, HTML）— ISPによるインターネット遮断を監視するWebアプリ。無関係。
3. **aswinshenoy/chowkidar** および **aswinshenoy/chowkidar-graphene**（GitHub, Python）— Django/Strawberry GraphQL向けJWT認証プラグイン。認可・認証寄りだが、checkpoint/exact-step resume/approval tokenのproblem spaceとは異なる。
4. **Geni-Wazir/chowkidar**（GitHub, Python）— セキュリティスキャン自動化ツール。無関係。
5. **p-society/chowkidaar** / **bhav09/chowkidar**（GitHub, Python）— 進捗監視Discord bot等。無関係。
6. **Chowdhury-DSP/ChowKick**, **Chowdhury-DSP/CHOW**（GitHub, C++）— オーディオ/シンセサイザープラグイン。完全に無関係のドメイン。
7. 一般名詞としての "chowki"（ヒンディー語/ウルドゥー語で「検問所・詰所」の意）を含む文化的・辞書的な言及（Wikipedia記事 "Chowk", "Chowk.com", "Chowki No. 2"（映画）等）— ソフトウェアプロジェクトではない。

タスク指示に明記されている通り、「実在し特定可能なプロジェクトを確信を持って見つけられない場合は、別ドメインの同名プロジェクトを無理に当てはめない」「アーキテクチャの詳細を捏造しない」というルールに従い、本ファイルでは対象を「対象不確定」として扱い、それ以上の詳細（State Machine, Architecture, Reusable Code/Schema/Pattern等）は記載していない。

## Suggested TACT Phase

なし（Prior Art調査の対象として採用不可のため、後続Phaseへの組み込みは提案しない）。もし "chowki" がユーザー側で把握している別名・別表記（例: 組織名を含むフルネーム、非公開/社内限定リポジトリ、あるいは検索エンジンにインデックスされていない小規模プロジェクト）であれば、正確なURLまたは正式名称を提供いただければ再調査する。
