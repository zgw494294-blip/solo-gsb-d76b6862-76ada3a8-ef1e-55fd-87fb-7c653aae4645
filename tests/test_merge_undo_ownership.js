"use strict";

// 前端「误合并撤销」的回归测试。
//
// 覆盖：
// 1. 每次合并成功建立撤销记录（两条原文、保留条款合并后正文与其余全部改写引用来源的
//    前后内部正文；两条原文自身不进 rewrites）；记录仅存本页内存——重新导入与成功
//    恢复存档清空；合并失败不产生记录。
// 2. 撤销经 HTTP /api/merge/undo：沿用写稿协调层（互斥、携带最新 lock_ids、
//    成功回包按最新锁定集合核验、旧响应隔离）；成功后记录移除、草稿恢复，之后无关
//    校订保留；422 / 409（冲突或锁定保护）时草稿与记录均保留。
// 3. 撤销成功后再撤销同一记录不被允许（记录已移除）；身份上界不回退；未完成编辑 /
//    拆分 / 写稿时不可撤销；撤销后超过 40 条前端拦截。
//
// 本文件用最小 DOM 桩在 Node 虚拟机中加载真实的 app/static/app.js（不修改它），
// 直接驱动合并按钮 / 撤销面板的真实事件处理器与内部函数，fetch 由测试逐个收尾。
// 运行：node --test tests/test_merge_undo_ownership.js（无第三方依赖）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// --------------------------------------------------------------------------- //
// 最小 DOM 桩（与其他前端归属测试同型：事件委托依赖 closest / dataset）
// --------------------------------------------------------------------------- //
function makeElement(name, id) {
  const listeners = new Map();
  const classes = new Set();
  const children = [];
  const el = {
    name,
    id: id || "",
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    title: "",
    dataset: {},
    children,
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    listeners, // 测试借此直接取面板上的真实 click 处理器（innerHTML 内容不建树）
    fire(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map((fn) => fn(event)));
    },
    appendChild(child) {
      children.push(child);
      child.parentNode = el;
    },
    closest(sel) {
      let node = el;
      while (node) {
        if (matchesSelector(node, sel)) return node;
        node = node.parentNode;
      }
      return null;
    },
    querySelector(sel) {
      return queryTree(el, sel, true);
    },
    querySelectorAll(sel) {
      return queryTree(el, sel, false);
    },
    scrollIntoView: () => {},
    focus: () => {},
    setSelectionRange: () => {},
    click: () => {},
  };
  return el;
}

function matchesSelector(node, sel) {
  const mAction = sel.match(/^\[data-action="?([^"\]]+)"?\]$/);
  if (mAction) return node.dataset && node.dataset.action === mAction[1];
  const mId = sel.match(/^#([\w-]+)$/);
  if (mId) return node.id === mId[1];
  if (sel.startsWith(".")) return node.classList && node.classList.contains(sel.slice(1));
  return node.name === sel;
}

function queryTree(root, sel, first) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (matchesSelector(child, sel)) {
        if (first) return child;
        found.push(child);
      }
      const got = walk(child);
      if (first && got) return got;
    }
    return null;
  };
  if (matchesSelector(root, sel)) {
    if (first) return root;
    found.push(root);
  }
  const one = walk(root);
  return first ? one || null : found;
}

// fetch 桩：记录每一次请求，响应时机与结果完全由测试控制；
// /api/preview 自动按 stateRef 中的当前草稿回包（与 app.js renderPreview 所需字段同型），
// 避免改稿成功后自动发出的预览在测试结束时仍 pending
function makeFetchStub(stateRef) {
  const calls = [];
  const previewPayload = () => {
    const st = stateRef.state;
    return {
      items: st.orderIds.map((cid, i) => ({
        id: cid,
        original: parseInt(cid.slice(1), 10),
        display: i + 1,
        text: st.clauses.find((c) => c.id === cid).body,
        broken: [],
      })),
      has_broken: false,
    };
  };
  const fetch = (url, opts = {}) =>
    new Promise((resolve) => {
      const call = {
        url,
        method: opts.method || "POST",
        body: opts.body ? JSON.parse(opts.body) : null,
        respond(status, data) {
          resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
        },
      };
      calls.push(call);
      // 预览默认自动回包（避免改稿后自动预览在测试结束时 pending）；需要观察
      // previewFresh=false 的用例可把 fetch.autoPreview 置为 false 后自行控制
      if (url === "/api/preview" && fetch.autoPreview) {
        call.respond(200, previewPayload());
      }
    });
  fetch.calls = calls;
  fetch.to = (urlPart) => calls.filter((c) => c.url.includes(urlPart));
  fetch.autoPreview = true;
  fetch.previewPayload = previewPayload;
  return fetch;
}

function loadApp() {
  const elements = new Map();
  const $el = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement(sel.replace(/^#/, ""), sel.replace(/^#/, "")));
    return elements.get(sel);
  };
  const stateRef = { state: null };
  const fetch = makeFetchStub(stateRef);
  const alerts = [];
  const confirms = [];
  const sandbox = {
    document: {
      querySelector: $el,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => makeElement("li"),
      createDocumentFragment: () => makeElement("fragment"),
    },
    fetch,
    confirm: () => {
      confirms.push(true);
      return true;
    },
    alert: (...args) => alerts.push(args.join(" ")),
    console,
  };
  const source = fs.readFileSync(APP_JS, "utf8");
  const hook =
    "\n;globalThis.__app = { state, submitWrite, syncMergePanel, mergeRecordStale, resolveInternalBody, " +
    " installArchive };\n";
  vm.createContext(sandbox);
  vm.runInContext(source + hook, sandbox, { filename: "app.js" });
  stateRef.state = sandbox.__app.state;
  return {
    fetch,
    $el,
    alerts,
    confirms,
    state: sandbox.__app.state,
    submitWrite: sandbox.__app.submitWrite,
    syncMergePanel: sandbox.__app.syncMergePanel,
    mergeRecordStale: sandbox.__app.mergeRecordStale,
    resolveInternalBody: sandbox.__app.resolveInternalBody,
    installArchive: sandbox.__app.installArchive,
    mergePanel: $el("#merge-panel"),
    mergeBody: $el("#merge-body"),
    mergeBtn: $el("#merge-btn"),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const roundTrip = (v) => JSON.parse(JSON.stringify(v));

// GOOD 文档（内部形态）
function setupDraft(app, clauses, orderIds) {
  app.state.clauses = clauses.map((c, i) => ({ id: c.id, original: i + 1, body: c.body }));
  app.state.orderIds = orderIds || clauses.map((c) => c.id);
  app.state.idCounter = app.state.clauses.length;
  app.state.pickIds = [];
  app.state.lockIds = [];
  app.state.writing = null;
  app.state.editingId = null;
  app.state.splittingId = null;
  app.state.mergeRecords = [];
  app.state.reviews = [];
  app.state.previewFresh = true;
  app.state.preview = {
    has_broken: false,
    items: app.state.clauses.map((c, i) => ({
      id: c.id,
      original: c.original,
      display: i + 1,
      text: c.body,
      broken: [],
    })),
  };
}

// 与后端 /api/merge 同口径地构造合并回包（前端提交协调层按回包安装）
function mergeResult(clauses, orderIds, keepId, dropId) {
  const byId = new Map(clauses.map((c) => [c.id, c.body]));
  const outClauses = [];
  const order_ids = [];
  for (const cid of orderIds) {
    if (cid === dropId) continue;
    let body = byId.get(cid);
    if (cid === keepId) body = `${body}；${byId.get(dropId)}`;
    body = body.replaceAll(`[[${dropId}]]`, `[[${keepId}]]`);
    outClauses.push({ id: cid, body });
    order_ids.push(cid);
  }
  return { order_ids, clauses: outClauses };
}

// 驱动真实「合并所选」点击到成功安装（fetch 由测试以合并结果收尾；预览 render 不 await）
async function doMerge(app, keepId, dropId) {
  const preClauses = app.state.clauses.map((c) => ({ id: c.id, body: c.body }));
  const preOrder = app.state.orderIds.slice();
  app.state.pickIds = [keepId, dropId];
  const beforeCalls = app.fetch.to("/api/merge").length;
  const done = app.mergeBtn.fire("click");
  await flush();
  const calls = app.fetch.to("/api/merge");
  assert.equal(calls.length, beforeCalls + 1);
  calls[calls.length - 1].respond(200, mergeResult(preClauses, preOrder, keepId, dropId));
  await done;
  await flush();
}

// 撤销面板的 innerHTML 内容不建真实节点：用合成目标触发面板上注册的真实 click 处理器
// （app.js 的处理器只依赖 ev.target.closest('[data-action="merge-undo"]')）
async function clickUndo(app, index) {
  const fns = app.mergePanel.listeners.get("click") || [];
  assert.ok(fns.length, "面板应注册 click 处理器");
  const target = {
    dataset: { action: "merge-undo", index: String(index) },
    closest(sel) {
      return matchesSelector(this, sel) ? this : null;
    },
  };
  const done = Promise.all(fns.map((fn) => fn({ target })));
  await flush();
  return done;
}

function undoCalls(app) {
  return app.fetch.to("/api/merge/undo");
}

// --------------------------------------------------------------------------- //
// 1. 记录建立与内存级生命周期
// --------------------------------------------------------------------------- //
test("合并成功建立撤销记录：两条原文 + keep_after + 其余改写来源的前后正文", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "甲方在七日内交付设备" },
    { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
    { id: "c3", body: "争议解决见 [[c4]]，违约参照 [[c2]]" },
    { id: "c4", body: "争议提交仲裁" },
  ]);
  await doMerge(app, "c1", "c2");

  assert.equal(app.state.mergeRecords.length, 1);
  const rec = app.state.mergeRecords[0];
  assert.deepEqual(
    {
      keep_id: rec.keep_id,
      drop_id: rec.drop_id,
      keep_before: rec.keep_before,
      drop_before: rec.drop_before,
      keep_after: rec.keep_after,
    },
    {
      keep_id: "c1",
      drop_id: "c2",
      keep_before: "甲方在七日内交付设备",
      drop_before: "乙方按 [[c1]] 验收后付款",
      keep_after: "甲方在七日内交付设备；乙方按 [[c1]] 验收后付款",
    },
  );
  // 仅 c3 是两条原文之外的改写来源（含 [[c2]]）；两条原文自身不进 rewrites
  assert.deepEqual(roundTrip(rec.rewrites), [
    {
      id: "c3",
      before: "争议解决见 [[c4]]，违约参照 [[c2]]",
      after: "争议解决见 [[c4]]，违约参照 [[c1]]",
    },
  ]);
  // 新记录在最前，面板显示
  assert.equal(app.mergePanel.hidden, false);
  assert.ok(app.mergeBody.innerHTML.includes("c1"));
});

test("无改写来源时 rewrites 为空；身份上界不随合并或撤销回退", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "第一条" },
    { id: "c2", body: "第二条" },
    { id: "c3", body: "第三条 [[c9]]" }, // 含失效引用，与合并不交叠
  ]);
  app.state.idCounter = 9;
  await doMerge(app, "c1", "c2");
  assert.deepEqual(roundTrip(app.state.mergeRecords[0].rewrites), []);
  assert.equal(app.state.idCounter, 9, "合并不推进上界");
});

test("合并失败不产生记录", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "第一条" },
    { id: "c2", body: "第二条" },
  ]);
  app.state.pickIds = ["c1", "c2"];
  const done = app.mergeBtn.fire("click");
  await flush();
  const calls = app.fetch.to("/api/merge");
  calls[0].respond(422, { detail: { errors: ["合并方向有误"] } });
  await done;
  await flush();
  assert.equal(app.state.mergeRecords.length, 0);
  assert.equal(app.mergePanel.hidden, true);
});

test("记录仅存本页：重新导入与成功恢复存档清空", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "第一条" },
    { id: "c2", body: "第二条" },
  ]);
  await doMerge(app, "c1", "c2");
  assert.equal(app.state.mergeRecords.length, 1);

  // 重新导入：清空
  await app.$el("#reimport-btn").fire("click");
  await flush();
  assert.deepEqual(roundTrip(app.state.mergeRecords), []);

  // 恢复存档：同样清空
  setupDraft(app, [
    { id: "c1", body: "第一条" },
    { id: "c2", body: "第二条" },
  ]);
  await doMerge(app, "c1", "c2");
  assert.equal(app.state.mergeRecords.length, 1);
  const snap = {
    baseline: {
      order_ids: ["c1"],
      clauses: [{ id: "c1", body: "存档第一条" }],
    },
    order_ids: ["c1"],
    clauses: [{ id: "c1", body: "存档第一条" }],
    id_counter: 1,
  };
  app.installArchive(snap, 3);
  assert.deepEqual(roundTrip(app.state.mergeRecords), []);
});

// --------------------------------------------------------------------------- //
// 2. 撤销：HTTP 提交、成功恢复、之后无关校订保留
// --------------------------------------------------------------------------- //
test("撤销经 /api/merge/undo：成功后恢复草稿与记录移除，携带 lock_ids", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "甲方在七日内交付设备" },
    { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
    { id: "c3", body: "争议解决见 [[c4]]，违约参照 [[c2]]" },
    { id: "c4", body: "争议提交仲裁" },
  ]);
  app.state.lockIds = ["c4"]; // 与撤销无关的锁定，仍随请求提交
  await doMerge(app, "c1", "c2");

  // 自动预览回包会让 previewFresh 立即追上；这里改为手动收尾以断言撤销刚成功时的"待预览"态
  app.fetch.autoPreview = false;
  const done = clickUndo(app, 0);
  const calls = undoCalls(app);
  assert.equal(calls.length, 1);
  // 请求体：当前稿 + 记录 + 最新锁定集合
  assert.deepEqual(calls[0].body.order_ids, ["c1", "c3", "c4"]);
  assert.equal(calls[0].body.record.keep_id, "c1");
  assert.deepEqual(calls[0].body.lock_ids, ["c4"]);

  // 先收尾合并后那次预览（响应与当时合并稿一致）
  const previews = app.fetch.to("/api/preview");
  previews.forEach((c) => c.respond(200, app.fetch.previewPayload()));

  // 与后端撤销结果同口径的回包
  const undone = {
    order_ids: ["c1", "c2", "c3", "c4"],
    clauses: [
      { id: "c1", body: "甲方在七日内交付设备" },
      { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
      { id: "c3", body: "争议解决见 [[c4]]，违约参照 [[c2]]" },
      { id: "c4", body: "争议提交仲裁" },
    ],
  };
  calls[0].respond(200, undone);
  await done;
  await flush();
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1", "c2", "c3", "c4"]);
  assert.equal(app.state.clauses[1].body, "乙方按 [[c1]] 验收后付款");
  assert.equal(app.state.mergeRecords.length, 0, "成功撤销后记录不可再用");
  assert.equal(app.mergePanel.hidden, true);
  // 撤销是改稿：新预览尚未返回前 previewFresh=false；存档标记未存档（touch 已走）
  assert.equal(app.state.previewFresh, false);
  assert.equal(app.state.archiveDirty, true);
  // 收尾撤销后自动发出的预览，避免 pending
  app.fetch.to("/api/preview").forEach((c) => c.respond(200, app.fetch.previewPayload()));
  await flush();
});

test("撤销保留之后无关的校订：只恢复记录涉及的条款", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "甲方在七日内交付设备" },
    { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
    { id: "c3", body: "第三条" },
  ]);
  await doMerge(app, "c1", "c2");
  // 合并后对无关条款 c3 做校订（直接改已保存正文，模拟一次成功保存）
  const c3 = app.state.clauses.find((c) => c.id === "c3");
  c3.body = "第三条已校订";
  app.state.rev += 1;

  const done = clickUndo(app, 0);
  const call = undoCalls(app)[0];
  call.respond(200, {
    order_ids: ["c1", "c2", "c3"],
    clauses: [
      { id: "c1", body: "甲方在七日内交付设备" },
      { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
      { id: "c3", body: "第三条已校订" },
    ],
  });
  await done;
  await flush();
  const byId = new Map(app.state.clauses.map((c) => [c.id, c.body]));
  assert.equal(byId.get("c3"), "第三条已校订", "之后无关校订保留");
});

test("可撤销任一未撤销项：保留较早记录，撤销较新记录", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "第一条" },
    { id: "c2", body: "第二条" },
    { id: "c3", body: "第三条" },
    { id: "c4", body: "第四条" },
  ]);
  await doMerge(app, "c1", "c2");
  await doMerge(app, "c3", "c4");
  assert.equal(app.state.mergeRecords.length, 2);
  // 新记录在前：0 是 c3+c4，1 是 c1+c2
  assert.equal(app.state.mergeRecords[0].keep_id, "c3");
  assert.equal(app.state.mergeRecords[1].keep_id, "c1");
  // 撤销较新的 c3+c4（索引 0）
  const done = clickUndo(app, 0);
  const call = undoCalls(app)[0];
  assert.equal(call.body.record.keep_id, "c3");
  call.respond(200, {
    order_ids: ["c1", "c3", "c4"],
    clauses: [
      { id: "c1", body: "第一条；第二条" },
      { id: "c3", body: "第三条" },
      { id: "c4", body: "第四条" },
    ],
  });
  await done;
  await flush();
  // 较早记录保留仍可用（面板重渲染包含该记录的撤销按钮文案）
  assert.equal(app.state.mergeRecords.length, 1);
  assert.equal(app.state.mergeRecords[0].keep_id, "c1");
  app.syncMergePanel();
  assert.ok(app.mergeBody.innerHTML.includes("撤销这次合并"));
});

// --------------------------------------------------------------------------- //
// 3. 失败整次拒绝：冲突 / 锁定保护 / 422，草稿与记录均保留
// --------------------------------------------------------------------------- //
test("409 冲突：草稿与记录都保留", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "甲方在七日内交付设备" },
    { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
  ]);
  await doMerge(app, "c1", "c2");
  const before = JSON.stringify({ o: app.state.orderIds, c: app.state.clauses });

  const done = clickUndo(app, 0);
  undoCalls(app)[0].respond(409, {
    detail: {
      errors: ["合并撤销记录与当前草稿冲突，整次拒绝（当前稿未改动）：", "身份 c1：正文不一致"],
      conflicts: [{ id: "c1", original: 1, kind: "keep_body_changed", detail: "正文不一致" }],
    },
  });
  await done;
  await flush();
  assert.equal(JSON.stringify({ o: app.state.orderIds, c: app.state.clauses }), before);
  assert.equal(app.state.mergeRecords.length, 1, "失败保留记录");
  assert.ok(app.alerts.join("\n").includes("撤销失败"));
});

test("成功回包按最新锁定集合核验：违例整次不安装，记录保留", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "甲方在七日内交付设备" },
    { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
  ]);
  await doMerge(app, "c1", "c2");
  // 请求发出后等待期间锁定 c1（回包把 c1 正文还原为合并前 -> 正文变化违例）
  const done = clickUndo(app, 0);
  app.state.lockIds = ["c1"];
  undoCalls(app)[0].respond(200, {
    order_ids: ["c1", "c2"],
    clauses: [
      { id: "c1", body: "甲方在七日内交付设备" },
      { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
    ],
  });
  await done;
  await flush();
  // 整次不安装：c2 未恢复，仍为合并后的 2 条
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1"]);
  assert.equal(app.state.mergeRecords.length, 1, "违例不消耗记录");
});

test("422 记录损坏：草稿与记录均保留", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "第一条" },
    { id: "c2", body: "第二条" },
  ]);
  await doMerge(app, "c1", "c2");
  const done = clickUndo(app, 0);
  undoCalls(app)[0].respond(422, { detail: { errors: ["撤销记录的合并后正文与两条原文不一致"] } });
  await done;
  await flush();
  assert.deepEqual(roundTrip(app.state.orderIds), ["c1"]);
  assert.equal(app.state.mergeRecords.length, 1);
});

// --------------------------------------------------------------------------- //
// 4. 操作门槛
// --------------------------------------------------------------------------- //
test("未完成编辑 / 拆分选择 / 写稿在途时不可撤销", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "第一条" },
    { id: "c2", body: "第二条" },
  ]);
  await doMerge(app, "c1", "c2");

  // 编辑中：不发请求
  app.state.editingId = "c1";
  app.syncMergePanel();
  let fired = clickUndo(app, 0);
  await flush();
  assert.equal(undoCalls(app).length, 0);
  await fired;

  // 拆分选择中：不发请求
  app.state.editingId = null;
  app.state.splittingId = "c1";
  app.syncMergePanel();
  fired = clickUndo(app, 0);
  await flush();
  assert.equal(undoCalls(app).length, 0);
  await fired;

  // 写稿在途：不发请求
  app.state.splittingId = null;
  app.state.writing = "merge";
  fired = clickUndo(app, 0);
  await flush();
  assert.equal(undoCalls(app).length, 0);
  await fired;
});

test("撤销后超过 40 条前端拦截（不发请求）", async () => {
  const app = loadApp();
  // 40 条合并为 39 条：撤销恢复为 40 条，允许
  setupDraft(
    app,
    Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 1}`, body: `条款${i + 1}` })),
  );
  await doMerge(app, "c1", "c2");
  assert.equal(app.state.orderIds.length, 39);
  let done = clickUndo(app, 0);
  await flush();
  assert.equal(undoCalls(app).length, 1);
  undoCalls(app)[0].respond(200, {
    order_ids: Array.from({ length: 40 }, (_, i) => `c${i + 1}`),
    clauses: Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 1}`, body: `条款${i + 1}` })),
  });
  await done;
  await flush();

  // 构造当前 40 条且记录仍可对得上的场景（直接布置）：撤销会变 41 条 -> 拦截
  setupDraft(
    app,
    Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 2}`, body: `条款${i + 2}` })),
  );
  app.state.mergeRecords = [
    {
      keep_id: "c2",
      drop_id: "c1",
      keep_before: "条款1前",
      drop_before: "条款1",
      keep_after: app.state.clauses[0].body,
      rewrites: [],
    },
  ];
  app.syncMergePanel();
  // drop_id=c1 当前不存在、keep 正文等于 keep_after -> 记录不显式标失效，只剩条数拦截
  assert.equal(app.mergeRecordStale(app.state.mergeRecords[0]), false);
  done = clickUndo(app, 0);
  await flush();
  assert.equal(undoCalls(app).length, 1, "第二次撤销请求未发出");
  assert.ok(app.alerts.join("\n").includes("41") || app.alerts.join("\n").includes("上限"));
  await done;
});

test("本地快速核对：记录与当前稿对不上时不发请求（记录保留，服务端仍为权威）", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "甲方在七日内交付设备" },
    { id: "c2", body: "乙方按 [[c1]] 验收后付款" },
  ]);
  await doMerge(app, "c1", "c2");
  // 保留方正文被改：标记为可能失效，撤销不发请求
  app.state.clauses[0].body += "；又改过";
  app.syncMergePanel();
  assert.equal(app.mergeRecordStale(app.state.mergeRecords[0]), true);
  const done = clickUndo(app, 0);
  await flush();
  assert.equal(undoCalls(app).length, 0);
  assert.equal(app.state.mergeRecords.length, 1);
  await done;
});

test("撤销是写稿操作：互斥（提交期间 state.writing=merge-undo）", async () => {
  const app = loadApp();
  setupDraft(app, [
    { id: "c1", body: "第一条" },
    { id: "c2", body: "第二条" },
  ]);
  await doMerge(app, "c1", "c2");
  const done = clickUndo(app, 0);
  await flush();
  assert.equal(app.state.writing, "merge-undo");
  undoCalls(app)[0].respond(200, {
    order_ids: ["c1", "c2"],
    clauses: [
      { id: "c1", body: "第一条" },
      { id: "c2", body: "第二条" },
    ],
  });
  await done;
  await flush();
  assert.equal(app.state.writing, null);
});
