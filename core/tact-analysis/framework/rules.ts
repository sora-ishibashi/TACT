import type { FrameworkDefinition, FrameworkInput, FrameworkItem, FrameworkRule } from "./types";
import type { ValidationIssue } from "../types";

type Classifier = (text: string) => string | undefined;
const textOf = (e: FrameworkInput["evidence"][number]) => (e.text || e.claim || "").trim();
const has = (text: string, terms: readonly string[]) => terms.some((term) => text.toLowerCase().includes(term.toLowerCase()));
function rule(definition: FrameworkDefinition, classifier: Classifier): FrameworkRule {
  return {
    ...definition, definition, category: "framework", execution: { deterministic: true, llmMode: "never" },
    preconditions: (input) => input.objective.trim() ? [] : [{ code: "INSUFFICIENT_FRAMEWORK_EVIDENCE", severity: "error", message: "Framework objective is required" }],
    execute(input) {
      const bySection = new Map(definition.sections.map((s) => [s.id, [] as FrameworkItem[]]));
      const warnings: ValidationIssue[] = [];
      for (const evidence of input.evidence) {
        const text = textOf(evidence); const sectionId = classifier(text);
        if (!sectionId) { if (text) warnings.push({ code: "UNCLASSIFIED_FRAMEWORK_EVIDENCE", severity: "info", message: "Evidence had no explicit framework signal", evidenceIds: [evidence.id] }); continue; }
        const items = bySection.get(sectionId); if (!items || !text) continue;
        const existing = items.find((item) => item.text === text);
        if (existing) existing.sourceEvidenceIds = [...new Set([...existing.sourceEvidenceIds, evidence.id])];
        else items.push({ id: `${sectionId}:${evidence.id}`, sectionId, text, kind: "fact", sourceEvidenceIds: [evidence.id], confidence: "medium" });
      }
      for (const section of definition.sections) {
        const items = bySection.get(section.id) ?? [];
        if (items.length === 0) warnings.push({ code: "INSUFFICIENT_FRAMEWORK_EVIDENCE", severity: "warning", message: `${section.label} has no safely classified evidence` });
        if (items.some((item) => /成長|increase|growth/i.test(item.text)) && items.some((item) => /縮小|decrease|decline/i.test(item.text))) warnings.push({ code: "CONFLICTING_FRAMEWORK_EVIDENCE", severity: "warning", message: `${section.label} contains explicitly conflicting growth signals`, evidenceIds: items.flatMap((item) => item.sourceEvidenceIds) });
      }
      const sections = definition.sections.map((section) => {
        const items = bySection.get(section.id)!;
        return { id: section.id, label: section.label, items, sourceEvidenceIds: [...new Set(items.flatMap((item) => item.sourceEvidenceIds))] };
      });
      const sourceEvidenceIds = [...new Set(sections.flatMap((s) => s.items.flatMap((i) => i.sourceEvidenceIds)))];
      return { frameworkId: definition.id, frameworkVersion: definition.version, sections, sourceEvidenceIds, warnings };
    },
    validate(output) {
      const issues: ValidationIssue[] = [...output.warnings]; const ids = new Set<string>();
      for (const section of output.sections) for (const item of section.items) {
        const key = `${section.id}\0${item.text}`; if (ids.has(key)) issues.push({ code: "DUPLICATE_FRAMEWORK_ITEM", severity: "warning", message: "Duplicate framework item", evidenceIds: item.sourceEvidenceIds }); ids.add(key);
        if (!item.text.trim() || item.sourceEvidenceIds.length === 0 || item.sourceEvidenceIds.some((evidenceId) => !evidenceId.trim())) issues.push({ code: "UNSUPPORTED_FRAMEWORK_ITEM", severity: "error", message: "Framework facts require text and provenance" });
      }
      return issues;
    },
  };
}
const req = [{ id: "evidence", kind: "text" as const, description: "Explicit evidence", required: true, minimumCount: 1 }];
export const swotRule = rule({ id: "framework.swot", version: "1", name: "SWOT", purpose: "Classify explicitly signalled internal and external facts", requirements: req, sections: [{id:"strength",label:"Strength",description:"Internal strength",required:false},{id:"weakness",label:"Weakness",description:"Internal weakness",required:false},{id:"opportunity",label:"Opportunity",description:"External opportunity",required:false},{id:"threat",label:"Threat",description:"External threat",required:false}] }, (t) => has(t,["強み","strength"]) && has(t,["自社","当社","company"]) ? "strength" : has(t,["弱み","weakness"]) && has(t,["自社","当社","company"]) ? "weakness" : has(t,["機会","opportunity"]) && has(t,["市場","規制","競合","external"]) ? "opportunity" : has(t,["脅威","threat"]) && has(t,["市場","規制","競合","external"]) ? "threat" : undefined);
export const threeCRule = rule({ id:"framework.3c",version:"1",name:"3C",purpose:"Classify explicitly labelled customer, competitor, and company facts",requirements:req,sections:[{id:"customer",label:"Customer",description:"Customer",required:false},{id:"competitor",label:"Competitor",description:"Competitor",required:false},{id:"company",label:"Company",description:"Company",required:false}] }, (t) => has(t,["顧客","customer","市場需要"]) ? "customer" : has(t,["競合","competitor","代替"]) ? "competitor" : has(t,["当社","自社","company"]) ? "company" : undefined);
export const pestRule = rule({ id:"framework.pest",version:"1",name:"PEST",purpose:"Classify explicit macro-environment signals",requirements:req,sections:[{id:"political",label:"Political",description:"Policy/regulation",required:false},{id:"economic",label:"Economic",description:"Economic",required:false},{id:"social",label:"Social",description:"Social",required:false},{id:"technological",label:"Technological",description:"Technology",required:false}] }, (t) => has(t,["法令","規制","政策","政府","条例","補助金"]) ? "political" : has(t,["gdp","物価","価格","市場規模","金利","為替"]) ? "economic" : has(t,["人口","高齢化","若者","文化","価値観","ライフスタイル"]) ? "social" : has(t,["ai","技術","自動化","研究開発","dx"]) ? "technological" : undefined);
