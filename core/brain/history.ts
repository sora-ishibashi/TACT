import {
  ExecutionRecord
} from "../context/types";


// ==========================
// Execution History
// ==========================

let executionHistory:
  ExecutionRecord[] = [];



// 保存

export function saveExecutionRecord(
  record: ExecutionRecord
){

  executionHistory.push(
    record
  );


  // 最大100件保持

  executionHistory =
    executionHistory.slice(-100);

}



// 取得

export function getExecutionHistory(){

  return executionHistory;

}