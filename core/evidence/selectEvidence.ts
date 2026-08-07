import { Evidence } from "../context/types";
import { retrieveEvidence } from "./retrieveEvidence";

export function selectEvidence(
  evidence: Evidence[],
  query: string,
  limit = 15
): Evidence[] {

  const selected =
    retrieveEvidence(
      evidence,
      query,
      limit
    );

  return selected.sort(
    (a, b) =>
      (b.score ?? 0) -
      (a.score ?? 0)
  );

}