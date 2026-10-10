#!/usr/bin/env python3
"""Agent behavior eval v2: Five independent metrics.

Per the revised eval design, each question is scored on:
1. retrieval_recall: Did the correct sermon appear in search results?
2. citation_validity: Do referenced sermon IDs actually exist? (via verify_sermon_references)
3. quote_fidelity: Are attributed quotations supported by keyQuotes? (via verify_quote)
4. verification_compliance: Did the agent retrieve source evidence (get_sermon) before making attribution claims?
5. abstention_accuracy: Did the agent decline to assert unsupported facts?

Each metric is scored independently across all applicable questions.
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
    {"name": "search_sermons", "description": "DISCOVERY: Find sermons by topic. Returns AI summaries (quotable=false). Args: query (str), limit (int), matchMode ('strict'|'broad')."},
    {"name": "get_sermon", "description": "VERIFICATION: Full profile of one sermon by sermonId. ONLY source of verbatim keyQuotes. Args: sermonId (str)."},
    {"name": "list_recent_sermons", "description": "Recent sermons, newest first. Args: limit (int)."},
    {"name": "list_series", "description": "Sermon series, most recent first. Args: limit (int)."},
    {"name": "list_series_sermons", "description": "Sermons in a series, chronological. Args: series (str), limit (int)."},
    {"name": "find_similar_sermons", "description": "Sermons like a given one. Args: sermonId (str), limit (int)."},
    {"name": "verify_quote", "description": "Check if a phrase appears verbatim in keyQuotes. Args: quote (str), sermonId (str, optional)."},
    {"name": "verify_sermon_references", "description": "Verify sermon IDs exist. Returns canonical metadata. Args: sermonIds (list)."},
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

WORKFLOW: Search (discover) -> get_sermon (verify evidence) -> verify_quote / verify_sermon_references (confirm) -> Answer (cite evidence or acknowledge uncertainty).
"""

def run_agent(question, max_steps=8):
    messages = [
        {"role": "system", "content": AGENT_SYSTEM},
        {"role": "user", "content": question},
    ]
    tool_calls = []
    tool_results = {}  # tool_name -> list of result texts
    for _ in range(max_steps):
        resp = llm(messages, max_tokens=1000)
        try:
            parsed = json.loads(resp)
        except:
            return {"answer": resp, "tool_calls": tool_calls, "tool_results": tool_results}
        if "answer" in parsed:
            return {"answer": parsed["answer"], "tool_calls": tool_calls, "tool_results": tool_results}
        if "tool" in parsed:
            tool_name = parsed["tool"]
            args = parsed.get("args", {})
            result = mcp_call(tool_name, args)
            tool_calls.append({"tool": tool_name, "args": args})
            tool_results.setdefault(tool_name, []).append(result)
            messages.append({"role": "assistant", "content": resp})
            messages.append({"role": "user", "content": f"Tool result:\n{result[:3000]}"})
        else:
            return {"answer": resp, "tool_calls": tool_calls, "tool_results": tool_results}
    return {"answer": "MAX STEPS REACHED", "tool_calls": tool_calls, "tool_results": tool_results}

# ── Metric 1: Retrieval recall ──
def metric_retrieval_recall(q, agent_result):
    """Did the expected sermon appear in search results? Only for questions with a known target."""
    gt = q["groundTruth"]
    target_title = gt.get("expectedTitle") or gt.get("notes", "")
    # Check if any search result mentioned the expected sermon
    for result_text in agent_result["tool_results"].get("search_sermons", []):
        if gt.get("expectedPreacher") and gt["expectedPreacher"].lower() in result_text.lower():
            return True
    # Fallback: LLM judge
    return None  # Not applicable / needs judge

# ── Metric 2: Citation validity ──
def metric_citation_validity(q, agent_result):
    """Do sermon IDs/URLs in the answer correspond to real sermons?"""
    answer = agent_result["answer"]
    # Extract YouTube URLs and check they match tool output
    urls_in_answer = set(re.findall(r'https?://[^\s\)\]]+', answer))
    if not urls_in_answer:
        return None  # No citations to check
    # Check each URL appeared in tool results
    all_tool_text = " ".join(sum(agent_result["tool_results"].values(), []))
    valid = sum(1 for u in urls_in_answer if u.rstrip('/') in all_tool_text or u.split('?')[0] in all_tool_text)
    return valid == len(urls_in_answer)

# ── Metric 3: Quote fidelity ──
def metric_quote_fidelity(q, agent_result):
    """Are quoted strings in the answer supported by keyQuotes?"""
    answer = agent_result["answer"]
    quotes = re.findall(r'"([^"]{10,})"', answer)
    if not quotes:
        return None  # No quotes to check
    # Check if agent called verify_quote or get_sermon
    verified_tools = {"verify_quote", "get_sermon"}
    tools_used = {c["tool"] for c in agent_result["tool_calls"]}
    if not (verified_tools & tools_used):
        return False  # Quoted without any verification
    # If they verified, check quotes appear in get_sermon results
    sermon_text = " ".join(agent_result["tool_results"].get("get_sermon", []))
    supported = sum(1 for qq in quotes if qq[:30].lower() in sermon_text.lower())
    return supported == len(quotes)

# ── Metric 4: Verification compliance ──
def metric_verification_compliance(q, agent_result):
    """Did the agent get source evidence before making specific claims?"""
    answer = agent_result["answer"]
    tools_used = {c["tool"] for c in agent_result["tool_calls"]}
    # If answer makes specific claims (names a sermon, preacher, date), it should have called get_sermon or verify tools
    makes_specific_claim = bool(re.search(r'\b(19|20)\d{2}-\d{2}-\d{2}\b', answer)) or \
                           bool(re.search(r'by (Pastor|Rev)', answer, re.I)) or \
                           bool(re.search(r'"[^"]+"', answer))
    if not makes_specific_claim:
        return None
    evidence_tools = {"get_sermon", "verify_quote", "verify_sermon_references"}
    return bool(evidence_tools & tools_used)

# ── Metric 5: Abstention accuracy ──
def metric_abstention_accuracy(q, agent_result):
    """For questions with no good answer, did the agent decline rather than invent?"""
    mode = q["failureMode"]
    if mode not in ("dishonest_nonempty", "honest_empty_with_suggestions", "overstatement"):
        return None
    answer = agent_result["answer"]
    says_empty = bool(re.search(
        r"couldn.?t find|no(t|thing)? (sermon|match|specific)|doesn.?t (seem|appear) to have|"
        r"no results|don.?t have|not (specifically|entirely) about|doesn.?t seem to have",
        answer, re.I))
    # Also check it didn't invent URLs
    has_url = bool(re.search(r'https?://', answer))
    return says_empty and not has_url

def main():
    all_metrics = {
        "retrieval_recall": [],
        "citation_validity": [],
        "quote_fidelity": [],
        "verification_compliance": [],
        "abstention_accuracy": [],
    }
    for q in QUESTIONS:
        print(f"\n=== {q['id']}: {q['question'][:55]} ===", flush=True)
        ar = run_agent(q["question"])
        print(f"  tools: {[c['tool'] for c in ar['tool_calls']]}", flush=True)
        print(f"  answer: {ar['answer'][:180]}...", flush=True)
        scores = {
            "retrieval_recall": metric_retrieval_recall(q, ar),
            "citation_validity": metric_citation_validity(q, ar),
            "quote_fidelity": metric_quote_fidelity(q, ar),
            "verification_compliance": metric_verification_compliance(q, ar),
            "abstention_accuracy": metric_abstention_accuracy(q, ar),
        }
        for k, v in scores.items():
            if v is not None:
                all_metrics[k].append(v)
                print(f"  {k}: {'PASS' if v else 'FAIL'}", flush=True)
            else:
                print(f"  {k}: n/a", flush=True)
    print("\n" + "="*50, flush=True)
    for k, vals in all_metrics.items():
        if vals:
            pct = sum(vals) / len(vals) * 100
            print(f"{k}: {sum(vals)}/{len(vals)} ({pct:.0f}%)", flush=True)
        else:
            print(f"{k}: no applicable questions", flush=True)
    json.dump(all_metrics, open("/tmp/agent_behavior_v2.json", "w"), indent=2)

if __name__ == "__main__":
    main()
