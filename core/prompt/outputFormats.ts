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
]
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
  "nextSearchSuggestions":[]
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
      "reason":"",
      "evidenceIds":[]
    }
  ],

  "competitorComparison":[
    {
      "company":"",
      "strengths":[],
      "weaknesses":[],
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
  ]
}`,

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
  "approved": true,
  "score": 92,
  "issues": [],
  "strengths": [],
  "improvements": [],
  "missingEvidence": []
}`,

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

  "recommendations": [],

  "nextActions": []

}
`,

};
