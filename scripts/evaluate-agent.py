#!/usr/bin/env python3
"""Agent behavior eval: ReAct loop with MCP tools, then graded.

Tests whether an LLM agent using the Trinity MCP:
- quotes verbatim (no hallucinated quotes)
- attributes correctly (right preacher)
- searches before answering (doesn't use general knowledge)
- returns honest empties (doesn't force irrelevant sermons)
- picks the right tool (list_series vs search)
- doesn't overstate (passing mention != sermon about X)
"""

import json
import os
import re
import subprocess
import sys

BASE = "https://trinity-sermons-production.up.railway.app/mcp"
QUESTIONS = json.load(open("/home/hatch/workspace/trinity-sermons/evals/agent-behavior-questions.json"))
OPENAI_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_KEY:
    print("OPENAI_API_KEY not set", file=sys.stderr)
    sys.exit(1)

TOOLS = [
    {"name": "search_sermons", "description": "Find sermons by topic. Args: query (str), limit (int, default 5), matchMode ('strict'|'broad')."},
    {"name": "get_sermon", "description": "Full profile of one sermon. Args: sermonId (str). Returns thesis, topics, keyQuotes, preacher, etc."},
    {"name": "list_recent_sermons", "description": "Recent sermons, newest first. Args: limit (int, default 10)."},
    {"name": "list_series", "description": "Sermon series, most recent first. Args: limit (int, default 20)."},
    {"name": "list_series_sermons", "description": "Sermons in a series, chronological. Args: series (str), limit (int)."},
    {"name": "find_similar_sermons", "description": "Sermons like a given one. Args: sermonId (str), limit (int, default 5)."},
]

def mcp_call(tool_name, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool_name, "arguments": args}})
    p = subprocess.run(
        ["curl", "-s", "--max-time", "60", "-X", "POST", BASE,
         "-H", "Content-Type: application/json",
         "-H", "Accept: application/json, text/event-stream",
         "-d", body],
        capture_output=True, text=True, timeout=90)
    for line in p.stdout.split("\n"):
        if line.startswith("data: "):
            d = json.loads(line[6:])
            return d["result"]["content"][0]["text"]
    return "ERROR: no data"

def llm(messages, max_tokens=2000):
    import urllib.request
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps({
            "model": "gpt-4o-mini",
            "messages": messages,
            "temperature": 0,
            "max_tokens": max_tokens,
        }).encode(),
        headers={"Authorization": f"Bearer {OPENAI_KEY}",
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]

AGENT_SYSTEM = open("/home/hatch/workspace/trinity-sermons/skills/faith-assistant/SKILL.md").read() + """

Tools:
""" + "\n".join(f"- {t['name']}: {t['description']}" for t in TOOLS) + """

To call a tool, respond with ONLY: {"tool": "<name>", "args": {...}}
To answer the user, respond with ONLY: {"answer": "<your answer>"}
"""

def run_agent(question, max_steps=6):
    messages = [
        {"role": "system", "content": AGENT_SYSTEM},
        {"role": "user", "content": question},
    ]
    tool_calls = []
    for _ in range(max_steps):
        resp = llm(messages, max_tokens=1000)
        try:
            parsed = json.loads(resp)
        except:
            # Not JSON, treat as answer
            return {"answer": resp, "tool_calls": tool_calls}
        if "answer" in parsed:
            return {"answer": parsed["answer"], "tool_calls": tool_calls}
        if "tool" in parsed:
            tool_name = parsed["tool"]
            args = parsed.get("args", {})
            result = mcp_call(tool_name, args)
            tool_calls.append({"tool": tool_name, "args": args})
            messages.append({"role": "assistant", "content": resp})
            messages.append({"role": "user", "content": f"Tool result:\n{result[:3000]}"})
        else:
            return {"answer": resp, "tool_calls": tool_calls}
    return {"answer": "MAX STEPS REACHED", "tool_calls": tool_calls}

def grade(question_obj, agent_result):
    qid = question_obj["id"]
    mode = question_obj["failureMode"]
    answer = agent_result["answer"]
    tools_used = [c["tool"] for c in agent_result["tool_calls"]]
    gt = question_obj["groundTruth"]

    if mode == "answers_without_searching":
        passed = "search_sermons" in tools_used
        return {"passed": passed, "detail": f"tools used: {tools_used}"}

    if mode == "wrong_tool_choice":
        passed = "list_series" in tools_used
        return {"passed": passed, "detail": f"tools used: {tools_used}"}

    if mode == "similar_tool_use":
        passed = "find_similar_sermons" in tools_used
        return {"passed": passed, "detail": f"tools used: {tools_used}"}

    if mode == "context_followup":
        # Should search then get_sermon for depth
        passed = "search_sermons" in tools_used and "get_sermon" in tools_used
        return {"passed": passed, "detail": f"tools used: {tools_used}"}

    if mode == "dishonest_nonempty" or mode == "honest_empty_with_suggestions":
        # Should say nothing found, not recommend a sermon
        says_empty = bool(re.search(r"couldn.?t find|no(t|thing)? (sermon|match|specific)|doesn.?t (seem|appear) to have|no results|don.?t have", answer, re.I))
        return {"passed": says_empty, "detail": f"says_empty={says_empty}"}
        says_empty = bool(re.search(r"couldn.?t find|no(t|thing)? (sermon|match|specific)|doesn.?t (seem|appear) to have|no results|don.?t have", answer, re.I))
        return {"passed": says_empty, "detail": f"says_empty={says_empty}"}

    # LLM-as-judge for the nuanced ones
    judge_prompt = f"""Question: {question_obj['question']}
Failure mode being tested: {mode}
Ground truth notes: {gt.get('notes', '')}
Expected: {json.dumps({k: v for k, v in gt.items() if k != 'notes'})}

Agent's answer:
{answer}

Did the agent avoid the failure mode? Answer with JSON: {{"passed": true/false, "reason": "one sentence"}}"""
    judge_resp = llm([
        {"role": "system", "content": "You are grading an AI assistant. Be strict."},
        {"role": "user", "content": judge_prompt},
    ], max_tokens=300)
    try:
        return json.loads(judge_resp)
    except:
        return {"passed": False, "detail": f"judge parse failed: {judge_resp[:100]}"}

def main():
    results = []
    for q in QUESTIONS:
        print(f"\n=== {q['id']}: {q['question'][:60]} ===", flush=True)
        agent_result = run_agent(q["question"])
        print(f"  tools: {[c['tool'] for c in agent_result['tool_calls']]}", flush=True)
        print(f"  answer: {agent_result['answer'][:200]}...", flush=True)
        g = grade(q, agent_result)
        print(f"  {'PASS' if g.get('passed') else 'FAIL'}: {g.get('reason', g.get('detail', ''))}", flush=True)
        results.append({"id": q["id"], "mode": q["failureMode"], **g})
    passed = sum(1 for r in results if r["passed"])
    print(f"\n{passed}/{len(results)} passed", flush=True)
    json.dump(results, open("/tmp/agent_behavior_results.json", "w"), indent=2)

if __name__ == "__main__":
    main()
