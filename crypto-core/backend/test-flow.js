// Run with the server already running:  node test-flow.js
// Requires Node 18+ (built-in fetch / FormData / Blob).
const B = process.env.API || "http://localhost:5000/api";
let pass = 0, fail = 0;

const check = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + extra}`);
};

async function req(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(B + path, { method, headers, body });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function makeUser(name, role) {
  const email = `${name}@test.com`, password = "pass123";
  await req("POST", "/auth/signup", { json: { name, email, password, role } }); // 409 if already exists, fine
  const r = await req("POST", "/auth/login", { json: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${name}: ${JSON.stringify(r.data)}`);
  return { token: r.data.token, id: r.data.user.id };
}

async function upload(setter, approvers, startOffsetMin, endOffsetMin, k = 2) {
  const now = Date.now();
  const form = new FormData();
  form.append("file", new Blob(["secret paper contents"]), "paper.txt");
  form.append("title", "Math Midterm");
  form.append("k", String(k));
  form.append("examStartTime", new Date(now + startOffsetMin * 60000).toISOString());
  form.append("examEndTime", new Date(now + endOffsetMin * 60000).toISOString());
  form.append("approverIds", JSON.stringify(approvers.map((a) => a.id)));
  return req("POST", "/papers", { token: setter.token, form });
}

(async () => {
  const health = await fetch(B.replace(/\/api$/, "/")).then((r) => r.json()).catch(() => null);
  check("server is up", !!health, "is the backend running on port 5000?");
  if (!health) return;

  const setter = await makeUser("setter1", "setter");
  const a1 = await makeUser("approver1", "approver");
  const a2 = await makeUser("approver2", "approver");
  const inv = await makeUser("invigilator1", "invigilator");
  check("4 users signed up + logged in", setter.token && a1.token && a2.token && inv.token);

  // ---- auth / roles ----
  let r = await req("GET", "/auth/profile");
  check("no token -> 401", r.status === 401, r.status);
  r = await req("GET", "/auth/setter-test", { token: a1.token });
  check("approver on setter route -> 403", r.status === 403, r.status);
  r = await req("GET", "/auth/me", { token: setter.token });
  check("/auth/me works", r.status === 200 && r.data.user?.role === "setter", r.status);

  // ---- upload (exam window includes now) ----
  const approvers = [a1, a2, inv];
  r = await upload(a1, approvers, -5, 60);
  check("approver cannot upload -> 403", r.status === 403, r.status);
  r = await upload(setter, approvers, -5, 60);
  check("setter upload -> 201", r.status === 201, JSON.stringify(r.data));
  const pid = r.data.id;

  // ---- unlock before approvals ----
  r = await req("POST", `/papers/${pid}/unlock`, { token: inv.token });
  check("unlock w/o approvals -> 403", r.status === 403, r.status);

  // ---- approvals ----
  r = await req("POST", `/papers/${pid}/approve`, { token: setter.token });
  check("non-approver approve -> 403", r.status === 403, r.status);
  r = await req("POST", `/papers/${pid}/approve`, { token: a1.token });
  check("approver1 approves (1/2)", r.status === 200 && r.data.approvalCount === 1, JSON.stringify(r.data));
  r = await req("POST", `/papers/${pid}/approve`, { token: a1.token });
  check("double approve -> 409", r.status === 409, r.status);
  r = await req("POST", `/papers/${pid}/unlock`, { token: inv.token });
  check("unlock with 1/2 approvals -> 403", r.status === 403, r.status);
  r = await req("POST", `/papers/${pid}/approve`, { token: a2.token });
  check("approver2 approves (2/2)", r.status === 200 && r.data.meetsThreshold === true, JSON.stringify(r.data));

  r = await req("GET", `/papers/${pid}/status`, { token: inv.token });
  check("status shows threshold met", r.status === 200 && r.data.meetsThreshold, JSON.stringify(r.data));

  // ---- unlock ----
  r = await req("POST", `/papers/${pid}/unlock`, { token: a1.token });
  check("non-invigilator unlock -> 403", r.status === 403, r.status);
  r = await req("POST", `/papers/${pid}/unlock`, { token: inv.token });
  check("invigilator unlock returns original file", r.status === 200 && r.data === "secret paper contents", `${r.status} ${JSON.stringify(r.data)}`);

  // ---- time lock ----
  let e = await upload(setter, approvers, 60, 120); // starts in the future
  await req("POST", `/papers/${e.data.id}/approve`, { token: a1.token });
  await req("POST", `/papers/${e.data.id}/approve`, { token: a2.token });
  r = await req("POST", `/papers/${e.data.id}/unlock`, { token: inv.token });
  check("too early -> 403", r.status === 403 && /not started/.test(r.data.message || ""), JSON.stringify(r.data));

  e = await upload(setter, approvers, -120, -60); // already ended
  await req("POST", `/papers/${e.data.id}/approve`, { token: a1.token });
  await req("POST", `/papers/${e.data.id}/approve`, { token: a2.token });
  r = await req("POST", `/papers/${e.data.id}/unlock`, { token: inv.token });
  check("too late -> 403", r.status === 403 && /closed/.test(r.data.message || ""), JSON.stringify(r.data));

  // ---- audit ----
  r = await req("GET", "/audit", { token: inv.token });
  check("audit history returns entries", r.status === 200 && Array.isArray(r.data) && r.data.length > 0, r.status);
  const actions = new Set((r.data || []).map((x) => x.action));
  console.log("      audit actions seen:", [...actions].join(", "));
  r = await req("GET", "/audit/verify", { token: inv.token });
  console.log("      audit verify result:", JSON.stringify(r.data));
  check("audit chain verify responds", r.status === 200, r.status);

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((err) => { console.error("Script error:", err); process.exit(1); });