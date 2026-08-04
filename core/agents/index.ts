import type { Agent } from "./types";

import { planner } from "./planner";
import { queryBuilder } from "./queryBuilder";
import { researcher } from "./researcher";
import { designer } from "./designer";
import { engineer } from "./engineer";
import { stakeholder } from "./stakeholder";
import { reviewer } from "./reviewer";
import { writer } from "./writer";


export const agents: Agent[] = [

  planner,

  queryBuilder,

  researcher,

  designer,

  engineer,

  stakeholder,

  reviewer,

  writer,

];


export {

  planner,

  queryBuilder,

  researcher,

  designer,

  engineer,

  stakeholder,

  reviewer,

  writer,

};