import {
  ExecutionRecord
} from "../context/types";


// ==========================
// Brain Pattern
// ==========================

export interface BrainPattern {

  // 使用されたAgent構成
  agents: string[];


  // 平均品質
  averageScore: number;


  // 実行回数
  count: number;


  // 成功率
  successRate: number;

}



// ==========================
// Pattern Analysis
// ==========================

export function analyzePatterns(
  records: ExecutionRecord[]
): BrainPattern[] {


  const patterns:
    Record<string, BrainPattern> = {};



  for (
    const record of records
  ) {


    const key =
      record.agents.join(",");



    if (
      !patterns[key]
    ) {


      patterns[key] = {

        agents:
          record.agents,


        averageScore:
          record.quality?.score ?? 0,


        count:
          1,


        successRate:
          record.success
            ? 1
            : 0,

      };


    } else {


      const pattern =
        patterns[key];


      pattern.count++;


      pattern.averageScore =
        (
          pattern.averageScore +
          (
            record.quality?.score ?? 0
          )
        ) / 2;



      if(record.success){

        pattern.successRate =
          (
            pattern.successRate *
            (pattern.count - 1)
            +
            1
          )
          /
          pattern.count;

      }
      else {

        pattern.successRate =
          (
            pattern.successRate *
            (pattern.count - 1)
          )
          /
          pattern.count;

      }

    }

  }



  return Object.values(
    patterns
  )
  .sort(
    (a,b)=>
      b.averageScore -
      a.averageScore
  );

}