import { AgentId } from "../agents/types";

export const outputFormats: Record<AgentId, string> = {
    
planner: `
========================
Planner Output Format
========================

{
  "goal":"",
  "category":"",
  "difficulty":"",
  "estimatedTime":"",
  "thinking":"",
  "reason":"",
  "plan":[]
}
`,

queryBuilder: `
========================
QueryBuilder Output Format
========================

{
  "intent":"",
  "searchTargets":[],
  "queries":[
    {
      "query":"",
      "priority":1
    }
  ],
  "reason":[]
}
`,

researcher: `
========================
Researcher Output Format
========================

{
  "toolRequests":[],
  "evidence":{
"market":[
  {
    "claim":"",
    "evidence":"",
    "source":"",
    "confidence":0,
    "reason":""
  }
],
      "competitors":[{
  "claim": "",
  "evidence": "",
  "source": "",
  "confidence": 0,
  "reason": ""
}],
    "users":[{
  "claim": "",
  "evidence": "",
  "source": "",
  "confidence": 0,
  "reason": ""
}],
    "businessModel":[{
  "claim": "",
  "evidence": "",
  "source": "",
  "confidence": 0,
  "reason": ""
}],
    "features":[{
  "claim": "",
  "evidence": "",
  "source": "",
  "confidence": 0,
  "reason": ""
}],
    "technology":[{
  "claim": "",
  "evidence": "",
  "source": "",
  "confidence": 0,
  "reason": ""
}],
    "financial":[{
  "claim": "",
  "evidence": "",
  "source": "",
  "confidence": 0,
  "reason": ""
}],
    "news":[{
  "claim": "",
  "evidence": "",
  "source": "",
  "confidence": 0,
  "reason": ""
}],
    "other":[{
  "claim": "",
  "evidence": "",
  "source": "",
  "confidence": 0,
  "reason": ""
}]
  },
  "missingInformation":[],
  "nextSearchSuggestions":[],
  "handoff": {
    "summary":"",
    "importantPoints":[],
    "missingInformation":[],
    "recommendedFocus":[]
  }
}
`,

analyst: `
========================
Analyst Output Format
========================

{
  "summary":"",

  "insights":[
    {
      "title":"",
      "importance":1,
      "background":"",
      "causeAndEffect":"",
      "futureImplication":"",
      "reason":"",
      "counterArguments":[],
      "evidenceIds":[]
    }
  ],

  "comparisons":[
    {
      "subject":"",
      "compareWith":"",
      "commonalities":[],
      "differences":[],
      "reason":"",
      "evidenceIds":[]
    }
  ],

  "opportunities":[
    {
      "title":"",
      "reason":"",
      "impact":"high",
      "evidenceIds":[]
    }
  ],

  "risks":[
    {
      "title":"",
      "reason":"",
      "severity":"high",
      "evidenceIds":[]
    }
  ],

  "recommendations":[
    {
      "priority":"high",
      "action":"",
      "reason":"",
      "evidenceIds":[]
    }
  ],

  "confidence":"high",

  "confidenceReason":""
}

insights[].background について:
Evidenceから確認できる事実・背景・文脈を簡潔に整理してください。
新しい事実を追加してはいけません。
Evidenceから直接説明できない内容を推測してはいけません。

insights[].causeAndEffect について:
Evidenceに明確な因果関係がある場合は、
「AがBを引き起こす／促進する／抑制する」という具体的な形で記述してください。
「〜に寄与する」「〜可能性がある」「〜につながる」のような弱い言い回しに逃げず、
Evidenceが支持する範囲で言い切ってください。
Evidenceから因果関係まで説明できない場合は、無理に因果を作らず「不明」としてください。
単なる相関や同時発生しかEvidenceから確認できない場合は、
それを因果関係として断定してはいけません。
重要なのは常に強い因果を書くことではなく、
Evidenceが許す範囲で因果を明確化し、分からなければ「不明」とすることです。

insights[].futureImplication について:
causeAndEffectで整理した因果関係を踏まえ、
ユーザーが未来予測を求めている場合は、10年後に想定される具体的な状態まで推論してください。
「影響が大きくなる」「重要になる」「変化する可能性がある」のような抽象的な表現だけで終わらせないでください。
可能な範囲で「何が」「どのように」「現在とどう違う状態になるのか」を具体化してください。
Evidenceから論理的に外挿できない場合は、無理に具体的な予測を作らず、
「Evidenceから具体的な将来状態を特定できない」と明記してください。
Evidenceに存在しない事実を創作してはいけません。

例:
悪い:「AIの普及によって労働市場が変化する可能性がある。」
良い:「定型的な分析業務の一部がAIに置き換わり、人間はAIの出力を評価・統合する役割へ移行する可能性がある。」
さらに良い:「10年後には、定型的な分析業務の多くがAIに委ねられ、人間は複数のAIの出力を評価し、最終的な意思決定や顧客との関係構築を担う形が一般化している可能性がある。」

insights[].reason について:
backgroundとcauseAndEffectを踏まえ、
「なぜこのInsightが重要なのか」「このInsightから何が読み取れるのか」を記述してください。
単なるEvidenceの言い換えではなく、Evidenceから導ける分析上の意味を記述してください。
ただしEvidenceにない事実を追加してはいけません。

insights[].counterArguments について(STEP66):
このInsightの結論に対して、Evidence上に
・反対方向の情報
・異なる解釈
・例外や限定条件
が存在する場合のみ記述してください。
Evidence上に反対方向の情報が存在しない場合は、無理に反証を
作成せず、counterArgumentsは空配列のままにしてください
(このフィールド自体は省略せず、必ず配列として返してください)。
Evidenceに基づかない反証を推測で作成してはいけません。

comparisons について:
企業比較だけを意味するものではありません。
企業・国や地域の政策・技術・専門家の立場・社会的変化など、
Evidence上で実際に比較可能な対象を比較する汎用構造です。
・比較可能な対象がEvidence上に実在する場合のみ記入する
・比較対象が存在しない場合は空配列でよい（comparisons: [] は正常な出力）
・Evidenceのsourceや発行元企業を、そのまま比較対象にしてはいけない
　（例: IBMの記事がEvidenceに存在するという理由だけでIBMをcompanyとして比較対象にしない）
・Evidenceにない対象同士を推測で比較してはいけない

opportunities / risks / recommendations について:
それぞれ独立した論点を、可能な限り複数抽出してください。
Evidenceに十分な根拠がある場合は、原則として各カテゴリ2件以上を生成してください。
ただし、Evidenceから独立した論点を2件以上成立させられない場合は、
無理に増やさず1件に留めてください。

複数件にする場合、それぞれは異なる観点・影響・対象・メカニズムを持つ
独立した内容にしてください。
同じ論点の言い換え、単なる表裏関係、因果関係の前後、粒度だけを変えた内容は
別項目として数えないでください。
（例:「AIによる職業創出」と「AIによる雇用拡大」のように実質的に同じ内容を
分けてはいけません。）

一方で、労働・教育・倫理・規制・企業・経済・技術・社会・人間関係など、
Evidenceに支持された異なる観点が存在する場合は、それらを積極的に分離して
抽出してください。

各項目は必ずEvidenceに直接対応付け、対応するevidenceIdsを設定してください。
Evidenceに直接支持されない推測を補完して項目数を増やしてはいけません。
重要度の低い論点を無理に追加して2件以上にする必要はありません。

最終的な項目数はEvidenceの内容によって決めてください。
ただし、「十分なEvidenceがあるのに1件だけで終わる」ことは避けてください。

重要: 「2件以上にすること」そのものを目的にせず、
「Evidenceに存在する独立した論点を取りこぼさず抽出すること」を目的としてください。

confidence について:
Analyst全体の分析に対する確信度を "high" / "medium" / "low" のいずれかで返してください。

confidenceReason について:
その確信度になった理由を、Evidenceの充足度・一貫性・不確実性などに基づいて簡潔に記述してください。
`,

designer: `
========================
Designer Output Format
========================

{
  "design":[],
  "assumptions":[]
}
`,

engineer: `
========================
Engineer Output Format
========================

{
  "architecture":[],
  "implementation":[]
}
`,

stakeholder: `
========================
Stakeholder Output Format
========================

{
  "value":[],
  "risks":[],
  "recommendations":[]
}
`,

reviewer: `
========================
Reviewer Output Format
========================

{
  "approved": boolean,
  "score": number,
  "issues": [],
  "strengths": [],
  "improvements": [],
  "missingEvidence": [],
  "retry": []
}

approvedは真偽値(true/false)そのものを、
scoreは0〜100の数値そのものを返してください。
文字列("true"や"92"等)にしないでください。`,

writer: `
========================
Writer Output Format
========================

{
  "title": "",

  "executiveSummary": "",

  "sections": [

{
    "heading":"",
    "content":"",
    "evidenceIds":[]
}
  ],

"keyFindings": [
  {
    "title": "",
    "importance": 1,
    "summary": ""
  }
],

  "recommendations": [
    "..."
  ],

  "nextActions": [
    "..."
  ],

  "status": "complete",

  "confidence": "high",

  "confidenceReason": "...",

  "limitations": [
    "..."
  ],

  "suggestedTasks": [
    {
      "title": "",
      "prompt": "",
      "mode": "think"
    }
  ]

}

recommendations と nextActions は、
オブジェクトではなく文字列の配列で返してください。

sections は、EvidenceとAnalystの分析を、Prompt内の
「Output Spec」(詳細度・文字数の目安)に従って展開してください。
詳細な分量が求められている場合は、全体で3000〜10000文字程度に
なることもあります。簡潔な分量が求められている場合は、要点を
優先し無理に長くしないでください。

文字数を満たすためだけの水増しや、
Evidenceに存在しない推測の追加は禁止です。

sections[].evidenceIds について:
Shared Evidenceの各項目には「ID: xxxxxxxx-xxxx-...」という
Evidence IDが付与されています。そのsectionが実際に参照した
具体的な事実(数値・固有名詞・結論など)の根拠となったEvidenceの
IDだけを、対応するsectionのevidenceIdsへ設定してください。
Shared Evidence、またはWorkflow History内のAnalystの
insights[].evidenceIds等に実在するIDのみを使用してください。
新しいIDを作成してはいけません。
導入・まとめなど、特定のEvidenceに基づかないsectionでは、
無理に埋めず空配列のままにしてください。
`,

};
