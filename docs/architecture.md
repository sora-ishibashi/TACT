# Architecture

TACTは6つのCoreで構成される。

- Agent
- Workflow
- Prompt
- LLM
- Memory
- Tool

すべての処理はWorkflowを中心に動く。

User
 ↓
Workflow
 ↓
Agent
 ↓
Prompt Compiler
 ↓
LLM
 ↓
Memory
 ↓
Tool