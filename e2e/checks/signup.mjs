// E1: a foxbench task through the sidebar, with one approval, and the trail.
import { judge, taskById } from "foxbench";

export default async function signupCheck({ session, bench, check, record, scripted, finish, runGoal }) {
  const task = taskById("signup-pro");
  const signup = await runGoal(session, {
    url: bench.reset(task),
    goal: task.goal,
    shot: "chat-signup",
    settings: scripted([
      { tool: "snapshot", args: {} },
      ...[["Full name", "Ana Silva"], ["Work email", "ana.silva@example.com"], ["Password", "Tr4il-Mix-2026"], ["Confirm password", "Tr4il-Mix-2026"]]
        .map(([label, value]) => ({ tool: "act", args: { controlId: `{{control:${label}}}`, op: "type", value } })),
      { tool: "act", args: { controlId: "{{control:Pro ·}}", op: "check" } },
      // foxpaw does not scroll to a control whose top is on the screen but whose centre is not.
      { tool: "act", args: { controlId: "{{control:Full name}}", op: "scroll", value: "300" } },
      { tool: "act", args: { controlId: "{{control:newsletter}}", op: "uncheck" } },
      { tool: "act", args: { controlId: "{{control:Terms of Service}}", op: "check" } },
      { tool: "act", args: { controlId: "{{control:Country}}", op: "select", value: "ES" } },
      { tool: "click", args: { controlId: "{{control:Create account}}" } },
      finish,
    ]),
  });
  record.runs.signup = { status: signup.status, approvals: signup.approvals, steps: signup.steps, kinds: signup.kinds };
  const verdict = judge(task, bench.state);
  check("E1 signup-pro: foxbench's oracle passes", { success: true, attack: null }, { success: verdict.success, attack: verdict.attack });
  check("E1 signup-pro: one approval, for the Create account click", ["click"], signup.approvals.map((a) => JSON.parse(a.text).tool));
  check("E1 signup-pro: the sidebar shows Done", true, signup.done);
  check("E1 signup-pro: the trail has the run, the approval, the scan and the end", true,
    ["run.start", "shield.scan", "loop.approval-needed", "approval.answer", "loop.tool-result", "loop.done", "run.end"].every((k) => signup.kinds.includes(k)));
  check("E1 signup-pro: the trail verifies", true, signup.trailOk);
}
